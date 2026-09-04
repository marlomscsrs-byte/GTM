# Portal GTM

Portal operacional do Grupamento Tático de Motocicletas.

## Arquitetura

- Node.js + Express
- PostgreSQL
- Frontend HTML/CSS/JS
- JWT para sessão
- bcrypt para senhas
- Render Blueprint (`render.yaml`)

## Sem Google Sheets

Todos os dados foram planejados para PostgreSQL:
usuários, efetivo, ocorrências, serviços, cursos, certificações,
motocicletas, manutenções, comunicados e logs.

## Deploy no Render

1. Suba este projeto para um repositório Git.
2. No Render, crie um novo Blueprint.
3. Aponte para o repositório.
4. O `render.yaml` cria o serviço web e o PostgreSQL.
5. Execute `db/schema.sql` no banco para criar as tabelas.

## Próxima etapa

Adicionar endpoints CRUD e permissões por perfil para cada módulo.


## Configuração inicial

Na primeira inicialização, o servidor cria automaticamente todas as tabelas do PostgreSQL. Se ainda não existir nenhum usuário, o portal exibirá a tela de **Configuração Inicial** para criar o primeiro administrador.

Depois de criar o administrador, o cadastro inicial é bloqueado automaticamente. A autenticação usa JWT e as senhas são armazenadas com hash bcrypt.

### Render

O `render.yaml` cria o serviço Node.js e o PostgreSQL. O banco gratuito do Render é indicado apenas para testes, pois possui limitações de duração. Para produção, utilize um plano PostgreSQL adequado.
