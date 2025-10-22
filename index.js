const { 
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const { Boom } = require('@hapi/boom');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(chalk.cyan(text), resolve));

async function showMenu() {
  console.clear();
  console.log(chalk.green('+----------------------+'));
  console.log(chalk.green('|') + chalk.yellow('     READ SW MENU     ') + chalk.green('|'));
  console.log(chalk.green('+----------------------+'));
  console.log(chalk.green('|') + chalk.white(' 1. Pairing Code      ') + chalk.green('|'));
  console.log(chalk.green('|') + chalk.white(' 2. QR Code           ') + chalk.green('|'));
  console.log(chalk.green('+----------------------+'));

  const choice = (await question('Pilih metode login (1/2): ')).trim();
  return choice === '1';
}

async function start() {
  try {
    const usePairing = await showMenu();
    const { state, saveCreds } = await useMultiFileAuthState('./sesi');

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' })
    });

    if (usePairing && !sock.authState?.creds?.registered) {
      console.log(chalk.white('\nSilahkan ikuti langkah berikut:'));
      console.log(chalk.white('1. Buka WhatsApp di HP kamu'));
      console.log(chalk.white('2. Tap Menu atau Settings'));
      console.log(chalk.white('3. Tap Perangkat Tertaut'));
      console.log(chalk.white('4. Tap Tambahkan Perangkat'));
      console.log(chalk.white('5. Masukkan kode yang muncul dibawah\n'));

      const phone = (await question('Masukkan nomor WhatsApp: ')).trim();
      try {
        let code = await sock.requestPairingCode(phone);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log(chalk.yellow('\n+------------------+'));
        console.log(chalk.yellow('|') + chalk.red(' KODE WHATSAPP ') + chalk.yellow('|'));
        console.log(chalk.yellow('+------------------+'));
        console.log(chalk.yellow('|') + chalk.white(` ${code} `) + chalk.yellow('|'));
        console.log(chalk.yellow('+------------------+\n'));
      } catch (e) {
        console.error('Gagal meminta pairing code:', e?.message || e);
      }
    }

    const autoReadStatus = true; // Bisa diubah jadi false untuk menonaktifkan fitur
    
    sock.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const msg = chatUpdate.messages?.[0];
        if (!msg) return;

        // Cek apakah pesan adalah status dan bukan dari kita sendiri
        if (msg.key && !msg.key.fromMe && msg.key.remoteJid === 'status@broadcast' && autoReadStatus) {
          // Skip jika pesan protocol
          if (msg.message?.protocolMessage) return;
          
          // Cek apakah status masih dalam batas waktu 5 menit
          const maxTime = 5 * 60 * 1000;
          const timeDiff = Date.now() - (msg.messageTimestamp * 1000);
          
          if (timeDiff <= maxTime) {
            try {
              // Baca emoji dari file
              let emojis;
              try {
                const emojiPath = path.join(__dirname, 'KUMPULAN_EMOJI', 'emojis.json');
                const emojiData = fs.readFileSync(emojiPath, 'utf8');
                const { reactions } = JSON.parse(emojiData);
                emojis = reactions;
              } catch (err) {
                console.error(chalk.red('⚠️ Error: Tidak bisa membaca file emoji di KUMPULAN_EMOJI/emojis.json'));
                console.error(chalk.yellow('📝 Petunjuk: Pastikan file emojis.json ada di folder KUMPULAN_EMOJI'));
                process.exit(1);
              }
              const random = emojis[Math.floor(Math.random() * emojis.length)];
              
              // Kirim reaction dan baca status
              await Promise.all([
                sock.readMessages([msg.key]),
                sock.sendMessage('status@broadcast', {
                  react: { 
                    text: random, 
                    key: msg.key 
                  }
                }, { 
                  statusJidList: [msg.key.participant] 
                })
              ]);
              
              // Tampilkan pesan sukses
              console.log(
                chalk.green('✓ Berhasil melihat status dari ') + 
                chalk.yellow(msg.pushName || 'Unknown') +
                chalk.green(' dengan reaction ') + 
                chalk.yellow(random)
              );
            } catch (err) {
              console.error(chalk.red('⚠️ Gagal memberikan reaction:'), err?.message || err);
            }
          }
        }
      } catch (err) {
        console.error(chalk.red('⚠️ Error:'), err?.message || err);
      }
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr && !usePairing) {
        console.log(chalk.cyan('\n=== CARA SCAN QR CODE ==='));
        console.log(chalk.white('1. Buka WhatsApp di HP kamu'));
        console.log(chalk.white('2. Ketuk Menu Titik Tiga (⋮) atau Settings'));
        console.log(chalk.white('3. Pilih WhatsApp Web/Desktop'));
        console.log(chalk.white('4. Pilih "Tambahkan Perangkat"'));
        console.log(chalk.white('5. Arahkan kamera ke QR code di bawah ini\n'));
        
        console.log(chalk.yellow('+-----------------------+'));
        console.log(chalk.yellow('|') + chalk.red('     SCAN QR CODE     ') + chalk.yellow('|'));
        console.log(chalk.yellow('+-----------------------+'));
        
        qrcode.generate(qr, { small: true });
        
        console.log(chalk.cyan('\nKeterangan:'));
        console.log(chalk.white('- QR code hanya aktif beberapa menit'));
        console.log(chalk.white('- Jika expired, tutup dan jalankan ulang program'));
      }
      
      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(chalk.yellow('[!] Connection closed, reason:'), reason);
        if (reason === DisconnectReason.loggedOut) {
          console.log(chalk.red('[!] Logged out — delete sesi and scan again'));
          process.exit();
        } else {
          start();
        }
      } else if (connection === 'open') {
        console.log(chalk.green('\n+------------------+'));
        console.log(chalk.green('|') + chalk.white(' BOT CONNECTED! ') + chalk.green('|'));
        console.log(chalk.green('+------------------+\n'));
      }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}

start();