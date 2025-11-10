const { connectToWhatsApp } = require('./index');

connectToWhatsApp().then(() => {
  console.log('Test bot lancé ! Envoie des messages via WhatsApp.');
});
