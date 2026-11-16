# Lembrei Bot

Bot pessoal de lembretes no Telegram, em TypeScript, Cloudflare Workers e D1.
Esta versão comunitária está em preparação e ainda não foi validada em produção.
Distribuído sob a licença MIT; consulte [LICENSE](LICENSE).

## Recursos

- Criar, listar, editar, adiar, concluir e excluir lembretes.
- Categorias, modelos, recorrência simples e registro de água.
- Comandos e teclado; restrito ao chat privado do dono.
- Webhook autenticado por cabeçalho, sem segredo na URL.
- Não há integração de IA implementada nem requisito de Gemini.

## Desenvolvimento e testes

Use Node.js 24 ou superior e um bot de teste, nunca a instalação em uso.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Preencha os valores SOMENTE no arquivo ignorado .dev.vars.
npm run db:local
npm run check
npm run dev
```

Os testes usam SQLite em memória e Telegram simulado, sem credenciais ou acesso remoto.
`npm test` também funciona sem instalar dependências no Node 24. O typecheck precisa delas.
O banco de exemplo tem UUID vazio; não contém identificadores do banco original.

## Instalação independente (apenas quando desejar implantar)

1. Crie seu bot no BotFather do Telegram. Descubra seu próprio ID numérico.
2. Crie uma conta/projeto Cloudflare e um banco D1 próprio (`npx wrangler d1 create lembrei_bot`).
3. Copie o ID NOVO para `wrangler.jsonc`. Não reutilize recursos de outra instalação.
4. Configure os segredos no Worker com `npx wrangler secret put TELEGRAM_BOT_TOKEN`,
   `npx wrangler secret put OWNER_TELEGRAM_ID` e `npx wrangler secret put WEBHOOK_SECRET`.
   O segredo do webhook deve usar caracteres A-Z, a-z, 0-9, _ e -, com 32+ caracteres aleatórios.
5. `npm run db:remote` e `npm run deploy` alteram o ambiente remoto e podem gerar custos.
6. Faça POST em `https://SEU-WORKER.workers.dev/setup-telegram` com o cabeçalho
   `Authorization: Bearer SEU_SEGREDO` usando seu cliente HTTP seguro. Não coloque o segredo
   na URL, em screenshots, histórico compartilhado ou comandos salvos. O Worker registra
   `/telegram` com `secret_token` e preserva atualizações pendentes.
7. Abra o bot em chat privado, envie `/start`, crie um lembrete de teste e confira a entrega.

## Comandos

`/novo`, `/listar`, `/concluir 1`, `/adiar 1 amanha`, `/editar 1`, `/excluir 1`,
`/categorias`, `/agua 500`, `/cancelar`, `/modelos`.

Criação rápida: `/novo pagar internet amanha #casa mensal`.
Modelo: `/modelo conta pagar internet #casa mensal`, depois `/usar conta`.
Datas: hoje, amanhã ou AAAA-MM-DD, às 09:00 em UTC-03:00.
A escrita rápida aceita `amanha` sem acento; fluxo guiado aceita também `amanhã`.

## Limites e privacidade

- Não use para emergência, medicação crítica ou obrigações cuja perda cause dano.
- Cron confere a cada 30 minutos e REPETE pendências vencidas até concluir/adiar.
- Recorrência usa aritmética simples; fim de mês pode avançar para o mês seguinte.
- Dedupe evita repetir a mesma atualização. Falha após gravá-la pode exigir reenviar o
  comando como nova mensagem; não há fila transacional/outbox de entrega garantida.
- `/excluir` marca o registro como excluído; não apaga fisicamente. Banco guarda títulos,
  notas, ID do dono, registros de água e rascunhos; o operador define retenção/backups.
- Telegram e Cloudflare processam dados. Não envie informações sensíveis desnecessárias.
- Testes locais não substituem ensaio real em conta/bot novos. 

## Migração de uma instalação anterior

Esta versão altera o contrato do webhook: `/telegram/SEGREDO` e
`/setup-telegram/SEGREDO` deixam de existir (404). Após implantar em ambiente de teste,
registre novamente usando POST `/setup-telegram` com Bearer. Só então teste o recebimento.
Não migre sua produção sem backup, autorização e plano de retorno. É recomendável trocar
um segredo anteriormente usado em URLs, pois pode ter sido registrado em logs/histórico.
O esquema do banco não foi alterado. A hora padrão muda de 09:00 UTC para 09:00 UTC-03;
registros existentes não são convertidos e mantêm seus instantes originais.
