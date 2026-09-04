const { app, safeStorage } = require('electron')
const path = require('node:path')

const userData = process.env.HERMES_PEEPS_TEST_USER_DATA
if (!userData || !path.win32.isAbsolute(userData)) {
  process.stderr.write('missing safe userData path\n')
  process.exit(2)
}

app.setPath('userData', userData)
app
  .whenReady()
  .then(() => {
    const available = safeStorage.isEncryptionAvailable()
    const plaintext = 'peeps-safe-storage-native-round-trip'
    const encrypted = available ? safeStorage.encryptString(plaintext) : Buffer.alloc(0)
    const roundTrip = available && safeStorage.decryptString(encrypted) === plaintext
    const ciphertextDistinct = available && !encrypted.includes(Buffer.from(plaintext))
    process.stdout.write(
      JSON.stringify({ available, ciphertextDistinct, roundTrip, userData: app.getPath('userData') })
    )
    app.exit(available && roundTrip && ciphertextDistinct ? 0 : 3)
  })
  .catch(() => app.exit(4))
