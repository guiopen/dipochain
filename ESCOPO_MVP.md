# Escopo do MVP da Disciplina (PD3) vs. Produto Final

Este documento delimita claramente o que o **MVP didático do DiploChain (PD3)** implementa de fato para a apresentação da disciplina e o que pertence apenas à visão de **Produto Final** descrita nos *White Papers* e no *Business Model Canvas*.

---

## 1. O que o MVP da disciplina faz de fato

O MVP entrega um fluxo completo ponta a ponta usando criptografia e smart contracts reais em uma rede EVM (local via Hardhat e opcionalmente em testnet pública Base Sepolia), cobrindo todos os cenários de avaliação da Seção 12 do *Technical White Paper*:

### 1.1. Contrato Inteligente (`DiploChain.sol`)
- **Registro de Emissores:** cadastrar instituições (`issuerId`, DID, nível de garantia `L1`/`L2`, endereço de recuperação e chave pública inicial), suspender/reativar (`Suspended`) e encerrar instituição (`Closed`).
- **Histórico de Chaves:** registrar janelas temporais (`validFrom`, `validUntil`, `compromisedAt`) por chave, suportando rotação de chave e reporte de comprometimento com timestamp retroativo (`reportCompromise`).
- **Ancoragem em Lote (EIP-712):** registrar a raiz de Merkle (`merkleRoot`), quantidade de credenciais, `schemaId` e timestamp do bloco mediante validação real de assinatura EIP-712 da chave ativa do emissor, permitindo que outra conta (Relayer) pague o gás.
- **Revogação On-Chain (EIP-712):** revogar permanentemente uma credencial (`(issuerId, leafHash)`) com código de motivo (`AdminError`, `IssuerError`, `Fraud`, `Superseded`), validando assinatura EIP-712 do emissor original.

### 1.2. Motor Criptográfico e CLI Independente (`core/`)
- Construção de credenciais no formato W3C VC 2.0 com `salt` aleatório de 128 bits, canonicalização RFC 8785 (JCS), cálculo de `leafHash` e assinatura ECDSA secp256k1.
- Construção e verificação de árvore de Merkle com pares ordenados (1 credencial ou lotes de 100 e 1.000 credenciais em 1 única transação).
- Verificação completa em 6 passos lendo apenas a blockchain (sem depender de servidores do emissor ou do DiploChain), retornando as **4 dimensões separadas** (Autenticidade, Legitimidade do Emissor, Validade Acadêmica como *"afirmada pelo emissor"* e Revogação/Status) e todos os vereditos explícitos: `VALID`, `VALID - ISSUER CLOSED`, `REVOKED`, `ISSUER SUSPENDED`, `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`, `INVALID SIGNATURE`, `TAMPERED`, `ISSUER NOT REGISTERED`, `ANCHOR NOT FOUND / UNCONFIRMED` e `EXPIRED`.
- **CLI de terminal** para demonstrar verificação 100% independente do portal web (cenário **S3**).
- **Simulador de baseline `did:web`** (mini servidor HTTP local) para comparar ao vivo os cenários em que `did:web` falha (emissor offline e comprometimento de chave).
- **Benchmark automatizado** medindo consumo de gás e tempo para lotes de 1, 100 e 1.000 credenciais (cenário **S2**).

### 1.3. Interface Gráfica Web (`web/`)
Aplicação web local (SPA) conectada diretamente ao RPC da blockchain, sem backend e sem banco de dados, organizada em 3 abas:
1. **Verificador Público:** recebe a credencial por arquivo `.json`, colagem de texto ou link/QR Code; exibe as 4 dimensões, o veredito final e os dados da transação on-chain; inclui atalhos para demonstrar casos negativos (como adulteração de campo).
2. **Portal do Emissor:** emite credencial única ou lote de N credenciais em 1 transação (exibindo o gás gasto), gera cartão visual com QR Code e download do `.json`, permite revogar credenciais escolhendo o motivo e rotacionar a chave institucional.
3. **Governança e Ciclo de Vida:** registra novas instituições, suspende/reativa ou encerra emissores e dispara reporte de comprometimento de chave com timestamp ajustável para demonstrar o cenário **N5** ao vivo.

---

## 2. Comparativo: MVP da Disciplina vs. Produto Final

| Aspecto | MVP da Disciplina (PD3) | Produto Final (Visão dos White Papers / BMC) |
| :--- | :--- | :--- |
| **Arquitetura de Contratos** | 1 contrato unificado (`DiploChain.sol`) com os 3 registros lógicos internos | 3 contratos separados, auditados externamente e atualizáveis com time-lock |
| **Rede Blockchain** | Rede EVM local (Hardhat) + deploy opcional em testnet pública (Base Sepolia) | Mainnet de uma L2 pública (Base, Polygon ou Arbitrum) com cross-anchoring periódico na Ethereum L1 |
| **Governança do Registro** | 1 conta de governança (admin) e 1 conta de recuperação por emissor | Multi-sig 3-of-5 (Fase 1) evoluindo para consórcio de instituições (Fase 2), com time-lock de 7 dias e log público |
| **Onboarding e KYB** | Cadastro direto pela aba de Governança | Validação jurídica (CNPJ, representante legal), prova de domínio via DNS TXT, consulta ao e-MEC e contrato comercial |
| **Custódia de Chaves** | Chaves de teste locais (ou carteira de teste) | HSM gerenciado com controle de acesso por papéis (RBAC), auditoria ou custódia multi-parte (MPC) |
| **Relayer e Pagamento de Gás** | Conta de Relayer operada no cliente/script submetendo assinaturas EIP-712 reais | Serviço backend dedicado de Relayer + tesouraria operacional convertendo cobrança em BRL para gás |
| **Emissão e Aprovação** | Emissão direta em 1 clique (unitária ou lote gerado/CSV) | Fluxo opcional de aprovação em duas etapas (*two-person approval*), limites diários (*probation caps*) e integração com ERPs acadêmicos |
| **Entrega ao Graduado** | Download do `.json` + cartão visual na tela com QR Code | Geração de PDF oficial com QR Code embutido, backup criptografado opcional e compartilhamento em 1 clique no LinkedIn/CV |
| **Encerramento de Instituição** | Status `Closed` congelando o registro e preservando credenciais anteriores | Transferência formal de direitos de revogação para um custodiante designado on-chain |
| **Web3 / Extensões Opcionais** | Não incluído | Soulbound Token (ERC-5192) opcional, prova criptográfica de posse do titular (nível *Strong*) e API de alto volume para RH/ATS |
| **Jurídico e Compliance** | Escopo estritamente didático | Revisão por DPO sobre LGPD (hashes com salt), adequação regulatória (MEC Portaria 554/2019) e SLA empresarial |
