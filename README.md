# Manual GTM — painel de efetivo integrado

Esta versão mantém o manual e adiciona um painel de efetivo à direita, alimentado pela aba `API` do Google Sheets por meio do Google Apps Script.

## Arquivos para publicar

Substitua no repositório do GitHub:

- `index.html`
- `style.css`
- `script.js`
- pasta `assets`

A API já está configurada no `script.js`.

## Atualização

O painel consulta a planilha ao abrir a página e repete a consulta a cada 5 minutos. Para testar uma alteração imediatamente, atualize a página do navegador.


## Administração

O menu lateral possui um botão **Administração** que abre o painel administrativo do Google Apps Script em uma nova aba. O acesso continua restrito às contas autorizadas no `Code.gs`.
