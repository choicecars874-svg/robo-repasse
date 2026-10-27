# Robô de Repasse – WhatsApp

## O que ele faz

1. **Escuta** os grupos de repasse escolhidos.
2. **Junta** as fotos e o texto que a mesma pessoa manda do mesmo carro.
3. **Lê** modelo, ano, km, cor, câmbio, preço e FIPE.
4. **Filtra**:
   - só pega os modelos que o comprador procura (aba *O que buscamos*);
   - só pega o que está pelo menos X% abaixo da FIPE. Se o anúncio não traz a FIPE, o robô consulta a tabela na internet;
   - descarta anúncios com sinistro, leilão etc.;
   - não posta o mesmo carro duas vezes.
5. **Apaga** o telefone, os links e o "chama no zap" do vendedor original.
6. **Soma a margem**. Exemplo: custo R$ 55.000 + R$ 3.000 = R$ 58.000.
7. **Coloca a logo da loja** em todas as fotos.
8. **Monta o texto** no modelo da loja, com o **link do WhatsApp** para o cliente chamar.
9. **Posta sozinho** (padrão). Carro sem FIPE encontrada é ignorado. Se um dia quiser revisar antes, troque para "Aprovar antes de postar" no painel.
10. **Posta** as fotos e o texto no grupo da loja, com uma pausa entre um carro e outro.

O painel mostra, para cada carro, quem é o vendedor original e de qual grupo ele veio. Assim vocês sabem com quem fechar.

---

## Onde deixar ligado 24h sem pagar

| Opção | Custo | Observação |
|---|---|---|
| **Oracle Cloud – Always Free** ⭐ | R$ 0 | Melhor opção grátis. Máquina boa e sem prazo para acabar. Pede cartão só para verificação. |
| Google Cloud – e2-micro | R$ 0 | Grátis só nas regiões dos EUA. 1 GB de memória, que é suficiente. Pede cartão. |
| PC ou notebook velho na loja | R$ 0 | Funciona, mas cai se faltar luz ou internet. |
| VPS barata (Hostinger, Contabo, Magalu Cloud) | ~R$ 25–40/mês | Se não quiser mexer com nuvem grátis. |

❌ **Não servem:** Vercel e Netlify (desligam a cada requisição), Render grátis (dorme e perde o login do WhatsApp) e Railway (não tem plano grátis permanente).

### Passo a passo – Oracle Cloud (grátis)

1. Crie a conta em **cloud.oracle.com** (escolha a região *Brazil East – São Paulo*).
2. Vá em **Compute → Instances → Create instance**:
   - Imagem: **Ubuntu 22.04 ou 24.04**
   - Shape: **Ampere (VM.Standard.A1.Flex)** com 1 OCPU e 6 GB. Se der "sem capacidade", use **VM.Standard.E2.1.Micro**.
   - Baixe a chave SSH que ele oferece.
3. Libere o acesso ao painel: na instância, clique na **Subnet → Security List → Add Ingress Rules**,
   com origem `0.0.0.0/0`, TCP, portas **80** e **443**.
4. Conecte na máquina. Pode ser pelo botão **Cloud Shell** do próprio site, ou pelo computador:
   `ssh -i chave.key ubuntu@IP_DA_MAQUINA`
5. Envie o projeto para a máquina (ou suba no GitHub e dê `git clone`) e rode:
   ```bash
   sudo apt-get update && sudo apt-get install -y unzip
   unzip robo-repasse.zip && cd robo-repasse
   bash instalar.sh
   ```
6. O script pede uma senha e no final mostra o endereço, algo como **https://129-146-10-20.sslip.io**.
   Abra esse endereço no celular, entre com a senha e escaneie o QR Code.

O script também deixa o robô **ligando sozinho** se o servidor reiniciar, e já configura **HTTPS grátis**.

---

## Primeira configuração (no painel)

1. **Início**: escaneie o QR Code com o WhatsApp que participa dos grupos.
2. **Configurar**:
   - clique em *Atualizar lista de grupos*;
   - marque os grupos de repasse e escolha o seu grupo;
   - preencha os dados da loja, o WhatsApp do link e a margem;
   - envie a logo (PNG com fundo transparente fica melhor) e ajuste posição e tamanho vendo a prévia.
3. **O que buscamos**: coloque os modelos que o comprador quer (ex.: `onix`, ano mínimo 2018, preço máximo 70000) e o desconto mínimo na FIPE.
4. **Testar anúncio**: cole um anúncio real do grupo e veja se ele seria pego e como ficaria.
5. Pronto: o robô já posta sozinho. Acompanhe a aba **Início** e o **Histórico** nos primeiros dias.

## Rodar no próprio computador (para testar)

```bash
npm install
PAINEL_SENHA=minhasenha npm start      # abra http://localhost:3000
```

## Cuidados

- Isso usa o WhatsApp Web por uma biblioteca **não oficial** (Baileys), e o WhatsApp pode **banir** números com cara de robô.
  Use um **chip separado** e não o número principal da loja.
- A FIPE consultada na internet é uma **estimativa**: o robô escolhe a versão mais parecida com o texto do anúncio.
  O Histórico mostra custo, venda e FIPE de cada carro postado.
- Confirme com o vendedor original que o carro ainda está disponível antes de fechar negócio.
- Comandos úteis no servidor: `pm2 logs repasse` (ver o que está acontecendo) e `pm2 restart repasse` (reiniciar).
