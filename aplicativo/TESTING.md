# Checklist de Teste Manual (Desktop MVP)

## Preparacao
- Backend rodando (`pnpm --filter backend dev`)
- Desktop rodando (`pnpm --filter aplicativo dev`)
- `.env` configurado com `VITE_API_URL`
- (DEV) Para ignorar creditos no fluxo: `VITE_DEV_BYPASS_CREDITS=true`

## Fluxo Cliente
- [ ] Abrir o app e escolher modo **Cliente**.
- [ ] Criar conta ou fazer login (header mostra "Ola, ...").
- [ ] Abrir **Marketplace** e ver PCs ONLINE (ou estado vazio).
- [ ] Clicar em **Reservar** em um PC online.
- [ ] Escolher duracao (preset 30m/1h/2h) e confirmar.
- [ ] Entrar na sessao e ver status/tempo restante.
- [ ] Clicar em **Conectar** e ver instrucoes internas.
- [ ] Encerrar a sessao e voltar ao marketplace com feedback.
 - [ ] Com `VITE_DEV_BYPASS_CREDITS=true`, a reserva deve funcionar mesmo com saldo 0.
 - [ ] Com a flag desativada, bloquear e mostrar "Saldo insuficiente" + CTA.

## Fluxo Host
- [ ] Abrir o app e escolher modo **Host**.
- [ ] Criar conta ou fazer login.
- [ ] Criar perfil de host (CTA no painel).
- [ ] Ver lista de PCs (vazia inicialmente).
- [ ] Abrir **Cadastrar PC**, preencher e salvar.
- [ ] Ver o PC listado com badge de status.
- [ ] Alternar ONLINE/OFFLINE e ver feedback visual.

## Navegacao e Estado
- [ ] Botao **Trocar modo** limpa o modo e volta para a home.
- [ ] Botao **Sair** limpa auth + modo e volta para a home.
