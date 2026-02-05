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

## Fluxo Cliente - Confiabilidade
- [ ] Host novo aparece com badge **Novo** no card do PC.
- [ ] Apos >=5 sessoes concluidas, o badge muda para **Confiavel**.
- [ ] Simular queda/erro e validar que o badge muda para **Instavel**.
- [ ] Tooltip do badge explica a base do score.

## Fluxo Cliente - Streaming (Pareamento Assistido)
- [ ] Clicar em **Conectar** na sessao e ver estados: "Preparando conexao..." e "Abrindo Moonlight...".
- [ ] Se Moonlight nao for encontrado, ver mensagem pedindo configurar o path em Configuracoes.
- [ ] Abrir o modal **Inserir PIN de pareamento**, informar um PIN e enviar.
- [ ] Ver mensagem de sucesso/erro no modal.

## Streaming - Robustez (Already Running)
- [ ] Cenario A: Sunshine ja aberto -> colocar PC ONLINE -> nao duplicar processo e logar "[STREAM][HOST] sunshine already running".
- [ ] Cenario B: Moonlight ja aberto -> clicar "Conectar agora" -> nao quebrar e logar "[STREAM][CLIENT] moonlight already running, attempting reuse".

## Streaming - Paths e UX (DEV)
- [ ] HOST com Sunshine instalado e sem Moonlight -> deve funcionar (nao exigir Moonlight).
- [ ] CLIENTE com Moonlight instalado e sem Sunshine -> deve funcionar (nao exigir Sunshine).
- [ ] Campo com path errado -> **Verificar** falha -> **Procurar...** seleciona o executavel correto -> **Verificar** sucesso.
- [ ] Campo vazio -> **Localizar automaticamente** encontra e preenche o executavel (quando instalado).
Resultado esperado: nao depende mais de copy/paste de path; evita erro de barras invertidas e aspas; HOST e CLIENTE nao exigem os dois softwares no mesmo PC durante DEV.

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

