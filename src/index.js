const robo = require('./robo');
const { iniciarPainel } = require('./painel');

iniciarPainel();
robo.iniciar();

process.on('unhandledRejection', (e) => console.error('Erro não tratado:', e));
