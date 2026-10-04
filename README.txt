REVENDEJÁ MARKETPLACE — V9 / RENDER

O V9 introduz a estrutura de LOJAS: cada vendedor pode ter até 2 lojas, cada
loja com UMA categoria própria (Vestuário, Eletrónica, Casa & Decoração,
Beleza & Saúde, Alimentos & Bebidas, Acessórios, Outros). Os produtos
pertencem à loja, por isso herdam automaticamente a categoria dela — uma
loja nunca consegue misturar categorias, porque a estrutura de dados não
permite.

Continua tudo na mesma aplicação (RevendeJá = área do vendedor por trás do
login; CompreJá = o catálogo público que qualquer cliente vê na página
inicial), partilhando o mesmo backend e base de dados, como combinado.

NOVIDADES DESTA VERSÃO
- Lojas: até 2 por vendedor, cada uma com nome, descrição, categoria e
  página pública própria (ex: /loja/o-slug-da-loja via API).
- Catálogo público (CompreJá) com filtro por categoria, além da pesquisa
  por nome/loja já existente.
- Notificação de pedido novo:
  - Na plataforma: o painel do vendedor mostra um aviso destacado quando
    há pedidos por atender, e marca-os com 🔔 na lista.
  - No WhatsApp: ao concluir o pedido, o cliente vê um botão que abre o
    WhatsApp dele já com a mensagem do pedido pronta para o número do
    vendedor (não precisa de configuração nem custo — é um link wa.me).
- Painel de Admin: secção "Lojas" para bloquear/ativar lojas individuais,
  além do que já existia para vendedores.
- Botão "Apagar" vendedor no painel de Admin (remove também as lojas,
  produtos, pedidos e pagamentos ligados a ele).

REGRAS PRINCIPAIS (mantidas)
- Cliente paga diretamente ao vendedor.
- Comissão padrão: 10% da venda, por conta do vendedor (ligada à conta do
  vendedor, não a uma loja específica).
- O vendedor começa com limite de comissão em dívida de 500 MT.
- Prazo padrão para comissão: 7 dias.
- Quando a dívida chega ao limite, novas vendas são bloqueadas em todas as
  lojas desse vendedor até regularização.

NÍVEIS DE CONFIANÇA (mantidos)
- NOVO: 0-2 pagamentos aprovados — limite 500 MT.
- EM_CRESCIMENTO: 3-5 — limite 1.500 MT.
- CONFIAVEL: 6-11 — limite 3.000 MT.
- VERIFICADO: 12+ — limite 5.000 MT.

VARIÁVEIS DE AMBIENTE (sem mudanças desde a V7 — ver histórico)
- DATABASE_URL, ADMIN_PASSWORD, ADMIN_SESSION_SECRET (obrigatórias/recomendadas)
- PUBLIC_BASE_URL, PAYMENT_API_BASE, PAYMENT_API_TOKEN, PAYMENT_CALLBACK_SECRET
  (opcionais, só para quando ligares pagamentos automáticos via agregador)

PRÓXIMAS FASES (do plano RevendeJá + CompreJá, ainda por fazer)
- Separar visualmente/estruturalmente CompreJá como uma "marca" própria
  dentro da mesma app (hoje é uma só página pública, sem nome CompreJá
  explícito na interface).
- Moderação/aprovação de produtos pelo admin antes de ficarem visíveis.
- Variantes/tamanhos de produto.
- WhatsApp Business API oficial para notificações 100% automáticas, sem
  precisar que o cliente clique (tem custo por mensagem — ver conversa
  sobre pagamentos para o mesmo tipo de configuração).

COMO EXECUTAR LOCALMENTE
1. Node.js 18+ e uma base de dados Postgres (local ou Neon/Supabase grátis).
2. Defina DATABASE_URL e ADMIN_PASSWORD no ambiente (ou num .env).
3. npm install
4. npm start
5. Abra http://localhost:3000

PUBLICAÇÃO NO RENDER
1. Repositório no GitHub com a pasta public/ incluída (index.html,
   style.css, app.js dentro dela).
2. Render → New → Web Service → conectar o repositório.
3. Build Command: npm install · Start Command: npm start
4. Environment: DATABASE_URL, ADMIN_PASSWORD, ADMIN_SESSION_SECRET.
5. Testar /health e a página principal depois do deploy.

Contacto oficial: WhatsApp +258 877 854 581.
