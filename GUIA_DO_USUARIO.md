# Guia do Usuário do DiploChain

## 1. O que o software faz

O DiploChain emite, ancora, revoga e verifica credenciais acadêmicas no formato W3C Verifiable Credential (VC 2.0) com registro em uma blockchain compatível com Ethereum (EVM). Os dados pessoais do titular ficam armazenados apenas no arquivo `.json` da credencial. Na blockchain ficam registrados os emissores credenciados, o histórico de chaves de cada emissor, as raízes de Merkle dos lotes emitidos e as revogações.

No protótipo da disciplina, as carteiras de governança, emissor, relayer e recuperação já vêm configuradas localmente para testes. O relayer envia as transações assinadas e paga o gás, enquanto o verificador realiza consultas públicas sem necessidade de conta ou login.

## 2. Acesso e configuração de rede

Após iniciar o ambiente local conforme o [README.md](./README.md), acesse a interface em `http://localhost:5173`. O endereço do contrato implantado localmente é carregado automaticamente.

Para consultar ou trocar a rede, clique no botão **Rede** (ou **Configurar rede**) no canto superior direito. O painel expandido permite alterar a **RPC URL**, informar outro endereço do contrato (como um deploy na testnet Base Sepolia), clicar em **Reconectar** e conferir os endereços das quatro contas embutidas (governança, emissor ativo, relayer e recuperação).

## 3. Tela Verificar

A tela **Verificar** atende qualquer verificador que receba uma credencial de um titular.

1. Envie a credencial arrastando o arquivo `.json` para a área **Upload .json** ou clicando nela para selecionar o arquivo no computador.
2. Caso prefira colar o texto do arquivo, clique em **Colar JSON manualmente**, insira o conteúdo e clique em **Verificar JSON**.
3. Se abrir um link gerado por QR Code (`/?vc=...`), a credencial é carregada e verificada automaticamente.

O painel à direita exibe o veredito geral (`VALID`, `VALID - ISSUER CLOSED`, `REVOKED`, `ISSUER SUSPENDED`, `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`, `INVALID SIGNATURE`, `TAMPERED`, `ISSUER NOT REGISTERED`, `ANCHOR NOT FOUND` ou `EXPIRED`), o tempo da consulta, o `leafHash` calculado e quatro cartões separados.

- **1. Autenticidade** indica se a assinatura ECDSA secp256k1, o hash com salt (JCS) e a prova de Merkle conferem com a âncora gravada no contrato, exibindo o hash da transação (`tx`).
- **2. Emissor** informa o DID do emissor, o nível de garantia (`L1` ou `L2`) e o status atual no registro (`Active`, `Suspended` ou `Closed`).
- **3. Validade Acadêmica** apresenta a afirmação feita pelo emissor na credencial, registrando que o reconhecimento acadêmico e legal permanece fora da verificação técnica.
- **4. Revogação e Prazo** confirma se o `leafHash` consta no registro de revogação do emissor (com o código de motivo) e se o campo `validUntil` expirou.

Na parte inferior do painel de envio, três botões facilitam o teste de cenários negativos a partir da credencial carregada. **Adulterar (N1)** altera a carga horária em memória para gerar `TAMPERED`. **Emissor falso (N2)** cria uma credencial assinada por uma chave não registrada para gerar `ISSUER NOT REGISTERED`. **Sem âncora (N6)** substitui a raiz de Merkle por um hash ausente no contrato para gerar `ANCHOR NOT FOUND`.

## 4. Tela Emitir

A tela **Emitir** opera com o emissor padrão `did:web:extensao.ufsc.br` e permite alternar entre dois modos no seletor superior.

- No modo **Individual**, preencha o nome do titular, o curso, a carga horária e, opcionalmente, uma data em **Expiração opcional (N7)**. Ao clicar em **Emitir e ancorar credencial**, o sistema assina a credencial, calcula a árvore de Merkle de uma folha e ancora a raiz no contrato via relayer.
- No modo **Lote**, informe o prefixo dos titulares, o curso, a carga horária e o **Tamanho do lote** (de 2 até 1.000 credenciais). Ao clicar em **Ancorar lote**, todas as credenciais entram na mesma árvore de Merkle e são ancoradas em uma única transação, exibindo o gás total e o gás por credencial no aviso superior.

As credenciais geradas aparecem na lista **Credenciais emitidas** à direita (em lotes grandes, as 10 primeiras ficam listadas para teste imediato). Em cada item há quatro ações disponíveis.

- **Verificar** envia a credencial diretamente para a tela **Verificar** e executa a validação.
- **QR Code** abre o cartão visual da credencial com o QR Code escaneável e o link **Abrir verificação direta**.
- **JSON** baixa o arquivo `.json` autossuficiente da credencial.
- **Revogar** grava a revogação permanente no contrato com o código selecionado no campo **Motivo ao revogar** (`AdminError`, `IssuerError`, `Fraud` ou `Superseded`).

No rodapé do formulário de emissão, o botão **Rotacionar chave** substitui a chave ativa `#key-2026-1` pela chave `#key-2027-1` no contrato. Credenciais ancoradas antes da rotação permanecem válidas, e novas emissões passam a usar a chave nova.

## 5. Tela Governança

A tela **Governança** reúne as ações da conta de governança e da conta de recuperação.

No painel **Emissores registrados**, cada emissor exibe seu DID, nível de garantia, status e tabela de chaves cadastradas. Os botões de status permitem **Suspender (N4)** um emissor ativo (fazendo suas credenciais retornarem `ISSUER SUSPENDED`), **Reativar** um emissor suspenso ou **Encerrar** permanentemente o emissor (`Closed`, mantendo credenciais anteriores válidas com o status `VALID - ISSUER CLOSED`).

Para testar o comprometimento de chave (cenário N5), defina o valor em **Janela N5 (s atrás)** e clique em **Reportar N5** na linha da chave desejada. A conta de recuperação assina `reportCompromise` via EIP-712 e bloqueia imediatamente novas ações daquela chave. Credenciais ancoradas antes do timestamp estimado continuam `VALID`, enquanto credenciais ancoradas a partir desse instante passam a retornar `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`.

No painel **Registrar emissor** à direita, informe um novo DID, escolha o nível de garantia (`L1` ou `L2`) e clique em **Registrar emissor** para cadastrá-lo no contrato.

## 6. Verificação pelo terminal (CLI)

Qualquer arquivo `.json` baixado na tela **Emitir** pode ser verificado de forma independente pelo terminal, consultando apenas a blockchain.

```bash
cd core && npm run verify -- <caminho-do-arquivo.json>
```

O comando exibe o veredito, o tempo de verificação, o `leafHash` e o resultado das quatro dimensões. Caso utilize outra rede ou contrato, informe os parâmetros opcionais `--rpc <url>` e `--contract <endereco>`.
