const bcrypt = require('bcryptjs');

async function generar() {
  const passwordPlano = '123456';
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(passwordPlano, salt);
  console.log('Copia este hash para tu SQL:', hash);
}

generar();