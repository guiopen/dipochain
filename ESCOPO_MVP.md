# Escopo do MVP da Disciplina (PD3) e Diferenças para o Produto Final

Este documento delimita o que o MVP do DiploChain (PD3) implementa para a apresentação na disciplina e o que pertence apenas à proposta de produto final descrita nos white papers e no Business Model Canvas. Os ajustes técnicos de especificação estão registrados em [AJUSTES_WHITEPAPER.md](./AJUSTES_WHITEPAPER.md).

## 1. Funcionalidades implementadas no MVP

O MVP executa o fluxo completo de emissão, ancoragem, revogação, ciclo de vida de chaves e verificação usando criptografia real e um contrato inteligente em rede EVM (rede local Hardhat e deploy opcional em testnet pública Base Sepolia). Ele cobre os 11 cenários definidos na Seção 12 do *Technical White Paper* (S1 a S4 e N1 a N7).

### 1.1. Contrato inteligente (`DiploChain.sol`)

- Registro de emissores com `issuerId`, DID, nível de garantia (`L1` ou `L2`), endereço de recuperação e chave inicial, além de transição de status para `Active`, `Suspended` e `Closed`.
- Histórico de chaves por emissor com janelas temporais (`validFrom`, `validUntil` e `compromisedAt`), suportando rotação de chave (`rotateKey`) e reporte retroativo de comprometimento (`reportCompromise`).
- Ancoragem de raízes de Merkle (`anchor`) e revogação permanente por `(issuerId, leafHash)` com código de motivo (`AdminError`, `IssuerError`, `Fraud` ou `Superseded`), ambas validadas por assinatura EIP-712 com proteção de `nonce` para envio via relayer.

### 1.2. Biblioteca criptográfica, CLI e scripts de avaliação (`core/` e `contracts/`)

- Geração de credenciais no formato W3C VC 2.0 com `salt` aleatório de 128 bits, canonicalização RFC 8785 (JCS), cálculo de `leafHash`, assinatura ECDSA secp256k1 e árvore de Merkle com pares ordenados.
- Motor de verificação somente-leitura que consulta diretamente o RPC da blockchain e retorna as quatro dimensões (autenticidade, legitimidade do emissor, validade acadêmica declarada pelo emissor e revogação/prazo) junto ao veredito (`VALID`, `VALID - ISSUER CLOSED`, `REVOKED`, `ISSUER SUSPENDED`, `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`, `INVALID SIGNATURE`, `TAMPERED`, `ISSUER NOT REGISTERED`, `ANCHOR NOT FOUND` e `EXPIRED`).
- CLI independente para verificar arquivos `.json` direto pelo terminal sem o portal web (cenário S3).
- Benchmark automatizado de gás e tempo para lotes de 1, 100 e 1.000 credenciais (cenário S2) e script comparativo contra um baseline `did:web` local (cenários S3 offline e N5).

### 1.3. Interface web (`web/`)

Aplicação SPA em React e TypeScript conectada diretamente ao RPC da blockchain, sem backend e sem banco de dados, organizada em três telas.

- **Verificar** permite enviar um arquivo `.json`, colar o JSON ou abrir o link do QR Code para exibir o veredito e as quatro dimensões da verificação, além de oferecer atalhos para simular adulteração (N1), emissor não registrado (N2) e âncora inexistente (N6).
- **Emitir** permite emitir credenciais individuais (S1 e N7) ou lotes via árvore de Merkle (S2) em uma transação, gerar o cartão com QR Code, baixar o `.json`, revogar credenciais (S4 e N3) e rotacionar a chave do emissor.
- **Governança** exibe os emissores e o histórico de chaves registrados no contrato, permite registrar novos emissores, suspender (N4), reativar, encerrar (`Closed`) e reportar comprometimento de chave com janela configurável (N5).

## 2. Comparativo entre MVP da disciplina e produto final

| Componente | MVP da disciplina (PD3) | Produto final (White Papers e BMC) |
| :--- | :--- | :--- |
| Contratos | Contrato único (`DiploChain.sol`) com os três registros internos | Três contratos separados, auditados externamente e atualizáveis com time-lock |
| Rede blockchain | Rede local Hardhat com deploy opcional na testnet Base Sepolia | Mainnet de uma L2 pública (Base, Polygon ou Arbitrum) com cross-anchoring periódico na Ethereum L1 |
| Governança | Uma conta de governança e uma conta de recuperação por emissor | Multi-sig 3-of-5 na Fase 1 e consórcio de instituições na Fase 2, com time-lock de 7 dias |
| Onboarding de emissores | Registro direto pela tela de Governança | Validação jurídica (CNPJ e representante legal), prova de domínio via DNS TXT e consulta ao e-MEC |
| Custódia de chaves | Contas de demonstração locais embutidas no cliente | HSM gerenciado com controle de acesso por papéis ou custódia multi-parte (MPC) |
| Relayer e cobrança | Conta de relayer operada no cliente submetendo assinaturas EIP-712 | Serviço backend dedicado de relayer e tesouraria operacional financiada por taxas em BRL |
| Fluxo de emissão | Emissão direta em um clique (individual ou lote gerado) | Aprovação em duas etapas, limites diários de emissão e integração com ERPs acadêmicos |
| Entrega ao titular | Download do arquivo `.json` e cartão na tela com QR Code | Geração de PDF com QR Code, backup criptografado opcional e compartilhamento no LinkedIn |
| Encerramento do emissor | Status `Closed` preservando credenciais ancoradas antes do fechamento | Transferência do direito de revogação para um custodiante designado no contrato |
| Extensões opcionais | Fora do escopo do MVP | Soulbound Token (ERC-5192), desafio criptográfico de posse do titular e API de verificação para RH/ATS |
| Adequação legal | Escopo exclusivamente didático | Revisão por DPO quanto à LGPD e análise regulatória frente à Portaria MEC 554/2019 |
