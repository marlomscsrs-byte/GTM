# Portal G.T.M.

Portal operacional do Grupamento Tático de Motocicletas.

## Arquitetura

- Node.js + Express
- PostgreSQL
- JWT + bcrypt
- Frontend HTML/CSS/JavaScript servido pelo próprio Node
- Deploy pelo Render via `render.yaml`

## Efetivo e contas

O cadastro inicial do efetivo é carregado automaticamente no PostgreSQL a partir de `db/schema.sql`. Cada integrante possui um registro próprio e, posteriormente, o comando pode criar uma conta individual pela aba **Efetivo**. A conta criada fica vinculada ao integrante através de `usuario_id`.

Isso permite manter o quadro oficial mesmo antes de todos os integrantes possuírem acesso ao portal.

## Primeiro acesso

Quando o banco ainda não possui usuários, o portal abre a configuração inicial para criação do primeiro administrador. Depois disso, somente usuários autorizados conseguem entrar.

## Render

O `render.yaml` cria o serviço web `portal-gtm` e o PostgreSQL `gtm-db` no mesmo Blueprint.
