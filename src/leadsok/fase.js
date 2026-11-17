// Fase do lead a partir da conversa no LeadsOK (com a Liz ou com o vendedor): checklist do que o cliente já passou.
// Roda na hora, sobre as mensagens lidas para o briefing. Nada do texto é gravado, e dados sensíveis (CPF, data de
// nascimento) nunca são mostrados: só "passou" / "não passou".
const SIM = /\b(sim|pode ser|pode sim|bora|vamos|vou sim|vou|quero|claro|fechado|combinado|ok|beleza|blz|perfeito|consigo|da sim|dá sim|confirmo|confirmado|t[aá] bom|t[aá] certo|certo)\b/i;
const PERGUNTA_VISITA = /(agend|visita|vir (at[eé] )?a loja|passar (aqui|na loja)|conhecer o carro|ver o carro|test.?drive)/i;
const HORARIO = /\b(\d{1,2}\s?h(\d{2})?|\d{1,2}:\d{2}|manh[aã]|tarde|noite|amanh[aã]|hoje|s[aá]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta|\d{1,2}\/\d{1,2})\b/i;

function faseDoLead(mensagens = [], { agenda = [], ficha = false, nome = '' } = {}) {
  const cli = mensagens.filter((m) => m.de === 'cliente');
  const txtCli = cli.map((m) => m.texto).join('\n');
  const itens = [];
  const add = (item, ok, detalhe = '') => itens.push({ item, ok: !!ok, detalhe });
  // após cada pergunta da loja/IA, a resposta seguinte do cliente
  const respostaA = (re) => {
    for (let i = 0; i < mensagens.length; i++) {
      if (mensagens[i].de === 'cliente' || !re.test(mensagens[i].texto)) continue;
      const r = mensagens.slice(i + 1).find((m) => m.de === 'cliente');
      if (r) return r;
    }
    return null;
  };
  add('Respondeu', cli.length > 0, cli.length ? `${cli.length} mensagem(ns) do cliente` : 'nenhuma mensagem do cliente no LeadsOK');
  const rNome = respostaA(/nome( completo)?/i);
  const passouNome = (rNome && /^[A-Za-zÀ-ÿ]+(\s+[A-Za-zÀ-ÿ]+){1,5}\s*$/.test(rNome.texto.trim())) || /\s/.test(String(nome || '').trim());
  add('Passou nome completo', passouNome);
  add('Passou CPF', /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(txtCli) || ficha, ficha ? 'tem ficha de financiamento' : '');
  add('Passou data de nascimento', /\b\d{1,2}\/\d{1,2}\/(19|20)?\d{2}\b/.test(txtCli));
  add('Falou de entrada / valor', /entrada|r\$\s?\d|\d+\s?(mil|k)\b|à vista|a vista|parcela/i.test(txtCli));
  add('Tem carro na troca', /troca|meu carro|tenho (um|uma)|dar (o meu|na troca)/i.test(txtCli));
  add('Quer financiar', /financ|parcel/i.test(txtCli) || ficha);
  const rVisita = respostaA(PERGUNTA_VISITA);
  const topou = (rVisita && SIM.test(rVisita.texto)) || cli.some((m) => PERGUNTA_VISITA.test(m.texto) && SIM.test(m.texto));
  add('Topou visitar', topou, rVisita ? `respondeu: "${rVisita.texto.slice(0, 80)}"` : '');
  const futura = agenda.filter((a) => a.modalidade !== 'ligacao' && !a.concluido && Date.parse(a.data) > Date.now()).sort((a, b) => (a.data < b.data ? -1 : 1))[0];
  const falouHorario = cli.some((m) => HORARIO.test(m.texto) && (PERGUNTA_VISITA.test(m.texto) || SIM.test(m.texto)));
  add('Horário da visita definido', !!futura || falouHorario, futura ? `agenda: ${new Date(futura.data).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${futura.pela_ia ? ' (marcado pela IA)' : ''}` : falouHorario ? 'o cliente citou dia/horário na conversa' : '');
  // resumo em uma frase
  const ok = (n) => itens.find((x) => x.item === n)?.ok;
  let fase;
  if (futura) fase = `Agendado para ${new Date(futura.data).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${futura.pela_ia ? ' pela IA: confirmar com o cliente' : ''}`;
  else if (topou && falouHorario) fase = 'Topou visitar e citou dia/horário, mas não está na agenda: confirmar e agendar';
  else if (topou) fase = 'Topou visitar, mas o horário não está confirmado';
  else if (ok('Passou CPF')) fase = 'Passou CPF (simulação de financiamento), ainda sem visita';
  else if (cli.length) fase = 'Em conversa, ainda sem visita';
  else fase = 'Não respondeu no LeadsOK';
  const faltam = itens.filter((x) => !x.ok && x.item !== 'Respondeu').map((x) => x.item.toLowerCase());
  return { fase, itens, faltam };
}

module.exports = { faseDoLead };
