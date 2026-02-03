# Checklist de Teste Manual (Desktop MVP)

## Preparacao
- Backend rodando (`pnpm --filter backend dev`).
- Desktop rodando (`pnpm --filter aplicativo dev`).
- `.env` configurado com `VITE_API_URL`.
- (DEV) Para ignorar creditos no fluxo: `VITE_DEV_BYPASS_CREDITS=true`.

## Fluxo Cliente - Marketplace e Fila
- [ ] Abrir o app e escolher modo **Cliente**.
- [ ] Criar conta ou fazer login (header mostra "Ola, ...").
- [ ] Abrir **Marketplace** e ver PCs com status ONLINE/BUSY/OFFLINE + "Fila: X".
- [ ] Clicar em **Conectar agora** em um PC ONLINE e navegar para a sessao.
- [ ] Clicar em **Conectar agora** em um PC BUSY e ver toast com posicao + navegar para a fila.
- [ ] Tela **Fila** mostra posicao e total de fila.
- [ ] Botao **Sair da fila** remove o usuario e volta ao marketplace.
- [ ] Encerrar uma sessao ativa e confirmar que o proximo da fila recebe "E sua vez!" e navega para a sessao.
- [ ] Botao **Conectar agora** desativado quando PC esta OFFLINE.

## Fluxo Cliente - Marketplace (Filtros e Favoritos)
- [ ] Filtrar por categoria (ex.: Jogos, Dev) e ver lista atualizada.
- [ ] Filtrar por software/plataforma (ex.: Steam, Photoshop) e ver lista atualizada.
- [ ] Limpar filtros e ver todos os PCs novamente.
- [ ] Favoritar um PC no card e ver a estrela ativa.
- [ ] Desfavoritar um PC e ver a estrela inativa.
- [ ] Tentar favoritar o mesmo PC duas vezes e confirmar que nao duplica.
- [ ] Abrir a area **Favoritos** e ver a lista de PCs/Hosts.
- [ ] Texto de protecao sobre jogos/softwares visivel no marketplace.

## Fluxo Cliente - Agendamento
- [ ] Abrir **Agendar** em um PC online e ver painel lateral.
- [ ] Ver horarios indisponiveis (availability) no painel.
- [ ] Criar reserva para data/hora futura e ver toast de sucesso.
- [ ] Tentar agendar horario conflitante e ver "Horario indisponivel".
- [ ] Tentar agendar no passado e ver erro.
- [ ] Abrir **Agendamentos** e confirmar lista de reservas do usuario.

## Fluxo Cliente - Sessao
- [ ] Sessao mostra status/tempo restante.
- [ ] Botao **Conectar** exibe instrucoes internas.
- [ ] Encerrar sessao e voltar ao marketplace com feedback.
- [ ] Com `VITE_DEV_BYPASS_CREDITS=true`, a reserva deve funcionar mesmo com saldo 0.
- [ ] Com a flag desativada, bloquear e mostrar "Saldo insuficiente".

## Fluxo Host
- [ ] Abrir o app e escolher modo **Host**.
- [ ] Criar conta ou fazer login.
- [ ] Criar perfil de host (CTA no painel).
- [ ] Ver lista de PCs (vazia inicialmente).
- [ ] Abrir **Cadastrar PC**, preencher e salvar.
- [ ] Ver o PC listado com badge de status.
- [ ] Alternar ONLINE/OFFLINE e ver feedback visual.
- [ ] Com PC local ONLINE/BUSY, trocar modo para **Cliente** e validar que o PC local fica OFFLINE automaticamente.

## Navegacao e Estado
- [ ] Botao **Trocar modo** limpa o modo e volta para a home.
- [ ] Botao **Sair** limpa auth + modo e volta para a home.
