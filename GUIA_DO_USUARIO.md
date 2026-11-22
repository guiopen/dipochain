# Guia do Usuário do DiploChain

## 1. O que o software faz

O DiploChain emite, ancora, revoga e verifica credenciais acadêmicas no formato W3C Verifiable Credential (VC 2.0) com registro em uma blockchain compatível com Ethereum (EVM). Os dados pessoais do titular ficam armazenados apenas no arquivo `.json` da credencial. Na blockchain ficam registrados os emissores credenciados, o histórico de chaves de cada emissor, as raízes de Merkle dos lotes emitidos e as revogações.

No ambiente local, as contas de governança, emissor, relayer e recuperação vêm configuradas automaticamente. O relayer envia as transações assinadas e paga o gás, enquanto o verificador realiza consultas públicas sem conta ou login.

## 2. Arquivos utilizados pelo sistema

Antes de operar as telas, convém entender os dois tipos de arquivo aceitos pela interface.

- **Arquivo `.json` da credencial** é a própria credencial digital gerada pelo DiploChain. O usuário obtém esse arquivo na tela **Emitir** clicando no botão **JSON** de uma credencial emitida (por exemplo, `vc-maria-silva.json`). Ele armazena os dados do titular (nome, curso, carga horária e datas), o `salt`, a assinatura do emissor e a referência da âncora na blockchain. O titular guarda esse arquivo e o entrega ao verificador para conferência na tela **Verificar** ou no CLI.
- **Arquivo `.csv` de lote (opcional)** é uma lista simples de titulares em texto plano usada apenas na tela **Emitir** (modo **Lote**), semelhante a uma planilha exportada do Excel ou de um sistema acadêmico. Cada linha representa um titular e pode seguir dois formatos, separados por vírgula ou ponto e vírgula. O formato de uma coluna contém apenas o nome do titular por linha, aproveitando o curso e a carga horária preenchidos no formulário. O formato de três colunas informa `nome,curso,carga_horaria` em cada linha. Se a primeira linha começar com `nome`, `name` ou `titular`, ela é tratada como cabeçalho e ignorada automaticamente.

## 3. Acesso e configuração de rede

Após iniciar o ambiente local conforme o [README.md](./README.md), acesse `http://localhost:5173`. O endereço do contrato implantado localmente é carregado automaticamente.

Para consultar ou trocar a rede, clique no botão **Rede** (ou **Configurar rede**) no canto superior direito. O painel permite alterar a **RPC URL**, informar outro endereço de contrato (como um deploy na testnet Base Sepolia), clicar em **Reconectar** e visualizar os endereços das quatro contas configuradas (governança, emissor ativo, relayer e recuperação).

## 4. Emitir credenciais (tela Emitir)

A tela **Emitir** opera com o emissor padrão `did:web:extensao.ufsc.br` e possui os modos **Individual** e **Lote**.

- No modo **Individual**, informe o nome do titular, o curso, a carga horária e, caso desejado, a **Data de expiração (opcional)**. Ao clicar em **Emitir e ancorar credencial**, o sistema assina a credencial, calcula uma árvore de Merkle de uma folha e ancora a raiz no contrato via relayer.
- No modo **Lote**, digite a lista de titulares (um nome por linha) ou clique em **Importar .csv** para carregar um arquivo `.csv` no formato descrito na Seção 2. Ao clicar em **Ancorar lote**, todas as credenciais entram na mesma árvore de Merkle e são ancoradas em uma única transação, exibindo o gás total e o gás por credencial.

As credenciais geradas aparecem na lista **Credenciais emitidas** à direita (em lotes grandes, as 20 primeiras ficam disponíveis na lista). Cada item oferece quatro ações.

- **Verificar** envia a credencial diretamente para a tela **Verificar** e executa a validação.
- **QR Code** abre o cartão visual da credencial com um QR Code escaneável e o link **Abrir verificação direta**.
- **JSON** baixa o arquivo `.json` da credencial para entrega ao titular ou verificação posterior.
- **Revogar** grava a revogação permanente no contrato com o código selecionado em **Motivo ao revogar** (`AdminError`, `IssuerError`, `Fraud` ou `Superseded`).

No rodapé do formulário de emissão, o botão **Rotacionar chave** substitui a chave ativa `#key-2026-1` pela chave `#key-2027-1` no contrato. Credenciais ancoradas antes da rotação permanecem válidas, e novas emissões passam a utilizar a chave nova.

## 5. Verificar credenciais (tela Verificar)

A tela **Verificar** atende qualquer verificador que receba uma credencial emitida na tela **Emitir**.

1. Arraste o arquivo `.json` da credencial para a área **Credencial (.json)** ou clique nela para selecionar o arquivo no computador.
2. Caso prefira colar o conteúdo do arquivo `.json`, clique em **Colar JSON manualmente**, insira o texto e clique em **Verificar JSON**.
3. Ao abrir um link gerado pelo botão **QR Code** (`/?vc=...`), a credencial é carregada e verificada automaticamente.

O painel à direita exibe o veredito (`VALID`, `VALID - ISSUER CLOSED`, `REVOKED`, `ISSUER SUSPENDED`, `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`, `INVALID SIGNATURE`, `TAMPERED`, `ISSUER NOT REGISTERED`, `ANCHOR NOT FOUND` ou `EXPIRED`), o tempo da consulta, o `leafHash` calculado e quatro cartões separados.

- **1. Autenticidade** indica se a assinatura ECDSA secp256k1, o hash com salt (JCS) e a prova de Merkle conferem com a âncora gravada no contrato, exibindo o hash da transação (`tx`).
- **2. Emissor** informa o DID do emissor, o nível de garantia (`L1` ou `L2`) e o status atual no registro (`Active`, `Suspended` ou `Closed`).
- **3. Validade Acadêmica** apresenta a afirmação feita pelo emissor na credencial, registrando que o reconhecimento acadêmico e legal permanece fora da verificação técnica.
- **4. Revogação e Prazo** confirma se o `leafHash` consta no registro de revogação do emissor (com o código de motivo) e se o campo `validUntil` expirou.

## 6. Gerenciar emissores e chaves (tela Governança)

A tela **Governança** reúne as operações da conta de governança e da conta de recuperação.

No painel **Emissores registrados**, cada emissor exibe seu DID, nível de garantia, status e tabela de chaves cadastradas. Os botões de status permitem **Suspender** um emissor ativo (fazendo suas credenciais retornarem `ISSUER SUSPENDED`), **Reativar** um emissor suspenso ou **Encerrar** permanentemente o emissor (`Closed`, mantendo credenciais anteriores válidas com o status `VALID - ISSUER CLOSED`).

Para reportar uma chave comprometida, informe a **Data/hora do comprometimento** no topo do painel e clique em **Reportar comprometimento** na linha da chave afetada. A conta de recuperação assina `reportCompromise` via EIP-712 e bloqueia novas ações daquela chave. Credenciais ancoradas antes do horário informado permanecem `VALID`, enquanto credenciais ancoradas a partir desse instante retornam `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`.

No painel **Registrar emissor** à direita, informe o DID do novo emissor, selecione o nível de garantia (`L1` ou `L2`) e clique em **Registrar emissor**.

## 7. Verificação pelo terminal (CLI)

Qualquer arquivo `.json` baixado na tela **Emitir** pode ser verificado de forma independente pelo terminal, consultando apenas a blockchain.

```bash
cd core && npm run verify -- <caminho-do-arquivo.json>
```

O comando exibe o veredito, o tempo de verificação, o `leafHash` e o resultado das quatro dimensões. Caso utilize outra rede ou contrato, informe os parâmetros opcionais `--rpc <url>` e `--contract <endereco>`.
