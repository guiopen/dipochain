# Guia do Usuário do DiploChain

## 1. O que o software faz

O DiploChain emite, ancora, revoga e verifica credenciais acadêmicas no formato W3C Verifiable Credential (VC 2.0) com registro em uma blockchain compatível com Ethereum (EVM). Os dados pessoais do titular ficam armazenados apenas no arquivo `.json` da credencial. Na blockchain ficam registrados os emissores credenciados, o histórico de chaves de cada emissor, as raízes de Merkle dos lotes emitidos e as revogações.

No ambiente local, as carteiras de governança, emissor, relayer e recuperação vêm configuradas automaticamente. O relayer envia as transações assinadas e paga o gás, enquanto o verificador realiza consultas públicas sem conta ou login.

## 2. Acesso e configuração de rede

Após iniciar o ambiente local conforme o [README.md](./README.md), acesse `http://localhost:5173`. O endereço do contrato implantado localmente é carregado automaticamente.

Para consultar ou trocar a rede, clique no botão **Rede** (ou **Configurar rede**) no canto superior direito. O painel permite alterar a **RPC URL**, informar outro endereço de contrato (como um deploy na testnet Base Sepolia), clicar em **Reconectar** e visualizar os endereços das quatro contas configuradas (governança, emissor ativo, relayer e recuperação).

## 3. Tela Verificar

A tela **Verificar** atende qualquer verificador que receba uma credencial de um titular.

1. Envie a credencial arrastando o arquivo `.json` para a área **Upload .json** ou clicando nela para selecionar o arquivo no computador.
2. Caso prefira inserir o texto do arquivo, clique em **Colar JSON manualmente**, cole o conteúdo e clique em **Verificar JSON**.
3. Ao abrir um link gerado por QR Code (`/?vc=...`), a credencial é carregada e verificada automaticamente.

O painel à direita exibe o veredito geral (`VALID`, `VALID - ISSUER CLOSED`, `REVOKED`, `ISSUER SUSPENDED`, `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`, `INVALID SIGNATURE`, `TAMPERED`, `ISSUER NOT REGISTERED`, `ANCHOR NOT FOUND` ou `EXPIRED`), o tempo da consulta, o `leafHash` calculado e quatro cartões separados.

- **1. Autenticidade** indica se a assinatura ECDSA secp256k1, o hash com salt (JCS) e a prova de Merkle conferem com a âncora gravada no contrato, exibindo o hash da transação (`tx`).
- **2. Emissor** informa o DID do emissor, o nível de garantia (`L1` ou `L2`) e o status atual no registro (`Active`, `Suspended` ou `Closed`).
- **3. Validade Acadêmica** apresenta a afirmação feita pelo emissor na credencial, registrando que o reconhecimento acadêmico e legal permanece fora da verificação técnica.
- **4. Revogação e Prazo** confirma se o `leafHash` consta no registro de revogação do emissor (com o código de motivo) e se o campo `validUntil` expirou.

## 4. Tela Emitir

A tela **Emitir** opera com o emissor `did:web:extensao.ufsc.br` e permite alternar entre os modos **Individual** e **Lote**.

- No modo **Individual**, preencha o nome do titular, o curso, a carga horária e, opcionalmente, a **Data de expiração (opcional)**. Ao clicar em **Emitir e ancorar credencial**, o sistema assina a credencial, calcula a árvore de Merkle de uma folha e ancora a raiz no contrato via relayer.
- No modo **Lote**, informe a lista de titulares (um nome por linha) ou importe um arquivo `.csv` pelo botão **Importar .csv**. O CSV aceita uma coluna com nomes (usando o curso e a carga horária preenchidos no formulário) ou três colunas separadas por vírgula ou ponto e vírgula (`nome,curso,carga_horaria`). Ao clicar em **Ancorar lote**, todas as credenciais entram na mesma árvore de Merkle e são ancoradas em uma única transação, exibindo o gás total e o gás por credencial.

As credenciais emitidas aparecem na lista **Credenciais emitidas** à direita (em lotes maiores, as 20 primeiras ficam disponíveis na lista). Cada item oferece quatro ações.

- **Verificar** envia a credencial para a tela **Verificar** e executa a validação.
- **QR Code** abre o cartão visual da credencial com o QR Code escaneável e o link **Abrir verificação direta**.
- **JSON** baixa o arquivo `.json` autossuficiente da credencial.
- **Revogar** grava a revogação permanente no contrato com o código escolhido em **Motivo ao revogar** (`AdminError`, `IssuerError`, `Fraud` ou `Superseded`).

No rodapé do formulário de emissão, o botão **Rotacionar chave** substitui a chave ativa `#key-2026-1` pela chave `#key-2027-1` no contrato. Credenciais ancoradas antes da rotação permanecem válidas, e novas emissões passam a usar a chave nova.

## 5. Tela Governança

A tela **Governança** reúne as ações da conta de governança e da conta de recuperação.

No painel **Emissores registrados**, cada emissor exibe seu DID, nível de garantia, status e tabela de chaves cadastradas. Os botões de status permitem **Suspender** um emissor ativo (fazendo suas credenciais retornarem `ISSUER SUSPENDED`), **Reativar** um emissor suspenso ou **Encerrar** permanentemente o emissor (`Closed`, mantendo credenciais anteriores válidas com o status `VALID - ISSUER CLOSED`).

Para reportar uma chave comprometida, informe a **Data/hora do comprometimento** no topo do painel e clique em **Reportar comprometimento** na linha da chave afetada. A conta de recuperação assina `reportCompromise` via EIP-712 e bloqueia novas ações daquela chave. Credenciais ancoradas antes do horário informado permanecem `VALID`, enquanto credenciais ancoradas a partir desse instante passam a retornar `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`.

No painel **Registrar emissor** à direita, informe o DID do novo emissor, selecione o nível de garantia (`L1` ou `L2`) e clique em **Registrar emissor**.

## 6. Verificação pelo terminal (CLI)

Qualquer arquivo `.json` baixado na tela **Emitir** pode ser verificado de forma independente pelo terminal, consultando apenas a blockchain.

```bash
cd core && npm run verify -- <caminho-do-arquivo.json>
```

O comando exibe o veredito, o tempo de verificação, o `leafHash` e o resultado das quatro dimensões. Caso utilize outra rede ou contrato, informe os parâmetros opcionais `--rpc <url>` e `--contract <endereco>`.
