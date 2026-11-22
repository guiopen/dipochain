# DiploChain (MVP PD3)

Protótipo desenvolvido para a disciplina de Blockchain e Criptomoedas (UFSC). Implementa emissão individual e em lote de *W3C Verifiable Credentials* (VCs), ancoragem de raízes de Merkle em rede EVM, meta-transações EIP-712 via relayer, revogação on-chain e verificação independente.

- Guia passo a passo de uso da aplicação: [GUIA_DO_USUARIO.md](./GUIA_DO_USUARIO.md)
- Ajustes técnicos em relação ao *Technical White Paper* (PD2): [AJUSTES_WHITEPAPER.md](./AJUSTES_WHITEPAPER.md)
- Delimitação entre MVP da disciplina e produto final: [ESCOPO_MVP.md](./ESCOPO_MVP.md)

## Estrutura do repositório

- `contracts/` contém o contrato `DiploChain.sol`, os testes automatizados (cenários S1 a S4 e N1 a N7), o benchmark de gás em lote e os scripts de deploy.
- `core/` contém a biblioteca TypeScript compartilhada (canonicalização JCS, geração de `salt`, cálculo de `leafHash`, árvore de Merkle, assinaturas EIP-712 e motor de verificação), o CLI independente (S3) e o script de comparação com `did:web`.
- `web/` contém a interface gráfica em Vite, React e TypeScript conectada diretamente ao RPC da blockchain, com contas locais configuradas para execução imediata.

## Arquivos usados pela aplicação

- **Credencial (`.json`)** é o arquivo gerado pelo próprio DiploChain quando o emissor emite uma credencial na tela **Emitir** e clica em **JSON** (por exemplo, `vc-maria-silva.json`). Esse arquivo contém os dados do titular, a assinatura do emissor e a prova de Merkle, sendo usado posteriormente na tela **Verificar** ou no CLI.
- **Lista de lote (`.csv`, opcional)** é um arquivo de texto com um titular por linha importado na tela **Emitir** (modo **Lote**). Aceita apenas nomes (usando o curso e a carga horária preenchidos no formulário) ou três colunas separadas por vírgula ou ponto e vírgula (`nome,curso,carga_horaria`), ignorando automaticamente a linha de cabeçalho.

## Pré-requisitos

Node.js (testado em v24), npm e Git.

## Execução local

### 1. Instalar dependências

```bash
cd contracts && npm install && cd ../core && npm install && cd ../web && npm install
```

### 2. Executar testes automatizados, benchmark de gás e baseline `did:web`

```bash
cd contracts && npm test && npm run benchmark && cd ../core && npm run baseline
```

### 3. Iniciar a blockchain local e a interface web

No primeiro terminal, inicie o nó local Hardhat.

```bash
cd contracts && npm run node
```

No segundo terminal, faça o deploy do contrato (que também registra o emissor padrão `did:web:extensao.ufsc.br`) e inicie a interface web em `http://localhost:5173`.

```bash
cd contracts && npm run deploy:local && cd ../web && npm run dev
```

### 4. Emitir e verificar pelo terminal (cenário S3)

Na interface web, acesse a tela **Emitir**, gere uma credencial e clique em **JSON** para baixar o arquivo (por exemplo, `vc-maria-silva.json`). Em seguida, verifique esse arquivo pelo terminal sem depender do portal web.

```bash
cd core && npm run verify -- <caminho-do-arquivo.json>
```

## Roteiro de demonstração

1. Na tela **Emitir**, preencha os dados de um titular e emita uma credencial individual (S1). Observe o gás registrado pelo relayer, abra o modal de **QR Code** e acesse o link de verificação para visualizar o resultado `VALID` nas quatro dimensões.
2. Na mesma tela, alterne para **Lote**, cole uma lista de titulares ou importe um arquivo `.csv` e clique em **Ancorar lote** para ancorar todas as credenciais em uma única transação (S2). Para métricas em escala (1, 100 e 1.000 credenciais), execute `npm run benchmark` em `contracts/`.
3. Baixe o arquivo `.json` de uma credencial emitida clicando em **JSON** e execute o verificador CLI no terminal (S3).
4. Na tela **Verificar**, abra **Colar JSON manualmente** com uma credencial carregada e edite o JSON para demonstrar os casos negativos. Alterar a carga horária gera `TAMPERED` (N1), alterar o campo `issuer` gera `ISSUER NOT REGISTERED` (N2) e alterar o `merkleRoot` demonstra falha de ancoragem (N6).
5. Na tela **Emitir**, gere uma credencial com data de expiração no passado para validar o cenário **N7** (`EXPIRED`). Em seguida, clique em **Revogar** em uma credencial válida para validar **S4** e **N3** (`REVOKED`).
6. Na tela **Governança**, teste **Suspender** (`ISSUER SUSPENDED`, N4), reative o emissor, informe uma data/hora entre duas emissões em **Data/hora do comprometimento** e clique em **Reportar comprometimento** (N5, mantendo a primeira credencial `VALID` e marcando a segunda como `UNDER REVIEW`) e clique em **Encerrar** para confirmar `VALID - ISSUER CLOSED`.
7. Execute `npm run baseline` em `core/` para exibir o comparativo entre `did:web` e DiploChain nos cenários S3 offline e N5.

## Deploy opcional na testnet Base Sepolia

1. Crie uma carteira de testes sem fundos reais e obtenha ETH de teste em um faucet da Base Sepolia.
2. Copie `contracts/.env.example` para `contracts/.env` e preencha `DEPLOYER_PRIVATE_KEY`.
3. Execute o deploy.

```bash
cd contracts && npm run deploy:sepolia
```

4. Na interface web, abra **Configurar rede** no topo, informe `https://sepolia.base.org` como RPC URL e cole o endereço salvo em `contracts/deployments/baseSepolia.json`.
