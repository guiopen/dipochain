# Ajustes e Decisões de Implementação em Relação ao Technical White Paper (PD2)

Este documento registra as incongruências, lacunas técnicas e simplificações de escopo identificadas no *Technical White Paper* (PD2) do **DiploChain**, junto com as soluções adotadas na implementação do protótipo didático (PD3).

---

## 1. Incongruências e Lacunas Técnicas

### 1.1. Escopo da revogação no `RevocationRegistry`
- **Problema identificado (Seção 4.3):** O contrato `AnchorRegistry` armazena apenas a raiz de Merkle (`root`) do lote, não as folhas individuais (`leafHash`). Porém, `RevocationRegistry.revoke(issuerId, leafHash, reasonCode, issuerSig)` armazena o status diretamente em `leafHash -> {revokedAt, reasonCode}`. Como o contrato não sabe a qual emissor aquele `leafHash` pertence, um emissor malicioso B poderia revogar uma credencial do emissor A caso conhecesse seu `leafHash`.
- **Solução adotada:** Indexar o registro de revogação pela dupla `(issuerId, leafHash)` no contrato. Cada emissor só consegue gravar no próprio namespace, eliminando a interferência entre emissores sem exigir o envio de prova de Merkle na revogação.

### 1.2. Derivação determinística de `issuerId` e `keyId`
- **Problema identificado (Seções 4.3 e 4.4):** A interface Solidity utiliza `bytes32 issuerId` e `bytes32 keyId`, enquanto o JSON da Verifiable Credential usa strings (`issuer: "did:web:extensao.ufsc.br"` e `verificationMethod: "did:web:extensao.ufsc.br#key-2026-1"`), sem definir formalmente a função de mapeamento entre ambos.
- **Solução adotada:** Padronizar a derivação determinística via `keccak256` sobre os bytes UTF-8 das strings:
  - `issuerId = keccak256(issuer)`
  - `keyId = keccak256(proof.verificationMethod)`
  - Assim, qualquer verificador resolve ambos os identificadores on-chain exclusivamente a partir do arquivo JSON da credencial.

### 1.3. Formato da assinatura da VC vs. padrão EVM
- **Problema identificado (Seção 4.4):** O exemplo de VC utiliza `proofValue` em formato ASN.1 DER (`0x3045...`), enquanto contratos Solidity e bibliotecas EVM operam nativamente com assinaturas ECDSA secp256k1 compactas de 65 bytes (`r, s, v`).
- **Solução adotada:** Utilizar assinaturas secp256k1 compactas de 65 bytes (padrão EVM) sobre o `VC_core` canonicalizado (RFC 8785). Mantém a mesma garantia criptográfica secp256k1 com total compatibilidade com ferramentas EVM e sem dependências adicionais de serialização ASN.1/LD-Proofs.

### 1.4. Ordenação de pares na Merkle Tree
- **Problema identificado (Seção 4.4):** O campo `anchorReference.merkleProof` é definido como uma lista simples de hashes, sem metadados de posição (`left`/`right`) para cada nó irmão.
- **Solução adotada:** Adotar árvore de Merkle com **pares ordenados** (padrão OpenZeppelin), ordenando lexicograficamente cada par de hashes antes de aplicar `keccak256`. Isso torna `merkleProof` autossuficiente no formato exato do white paper e trata lotes unitários como árvores de 1 folha (`merkleProof` vazio e `merkleRoot == leafHash`).

### 1.5. Funções e campos omitidos na especificação da interface
- **Problema identificado (Seções 4.3, 4.4 e 12):**
  - A interface `IDiploChainRegistries` especifica `anchor`, `revoke` e `reportCompromise`, mas omite funções necessárias para os cenários de avaliação do PD3: registro de emissores, alteração de status (`Suspended` para N4 e `Closed` para `VALID - ISSUER CLOSED`), rotação de chaves e cadastro da autoridade de recuperação (`recoverySigner`).
  - O exemplo de JSON da VC na Seção 4.4 omite o campo `validUntil`, exigido para validar o cenário **N7 (`EXPIRED`)**.
- **Solução adotada:** Implementar explicitamente no contrato as funções de ciclo de vida (`registerIssuer`, `setIssuerStatus`, `rotateKey`, além de `anchor`, `revoke` e `reportCompromise` com suporte a timestamp retroativo para demonstrar N5) e incluir o campo opcional `validUntil` (ISO-8601, padrão W3C VC 2.0) no `VC_core`.

### 1.6. Posição do `salt` no cálculo de `leafHash`
- **Problema identificado (Seção 4.4):** O texto define `leafHash = keccak256(salt || canonical(VC_core))`, ao mesmo tempo em que inclui o campo `salt` dentro do JSON de `VC_core`.
- **Solução adotada:** Seguir exatamente a fórmula do documento, removendo apenas `proof` e `anchorReference` antes da canonicalização RFC 8785 (JCS) e concatenando os bytes do `salt` antes do JSON canonicalizado, garantindo consistência exata entre emissor e verificador.

### 1.7. Inconsistência menor na nomenclatura de motivo de revogação
- **Problema identificado (Seção 5.3):** O exemplo descreve uma revogação registrada com o código `issuer error`, mas afirma que o verificador exibe `REVOKED - superseded` (ambos são valores distintos do enum `RevocationReason`).
- **Solução adotada:** O verificador exibe fielmente o código de motivo (`AdminError`, `IssuerError`, `Fraud`, `Superseded`) efetivamente gravado on-chain na transação de revogação.

### 1.8. Densidade do QR Code para VCs autossuficientes
- **Problema identificado (Seções 4.2 e 4.4):** Uma VC completa em JSON (payload + assinatura + prova de Merkle) possui aproximadamente 800 a 1.200 bytes, o que gera um QR Code denso quando codificado em texto puro.
- **Solução adotada:** Suportar verificação tanto por upload/colagem direta do arquivo `.json` quanto por QR Code/link contendo o payload comprimido em base64 na URL do verificador, mantendo o modelo *holder-held* sem servidor ou banco de dados.

---

## 2. Simplificações de Escopo para o MVP Didático (PD3)

Para adequar o protótipo ao escopo acadêmico da disciplina preservando integralmente os conceitos de blockchain e todos os cenários da Seção 12 (**S1–S4** e **N1–N7**), foram adotadas as seguintes simplificações:

| Componente no White Paper | Decisão no MVP (PD3) | Justificativa |
| :--- | :--- | :--- |
| 3 contratos separados (`IssuerRegistry`, `AnchorRegistry`, `RevocationRegistry`) | **Contrato único (`DiploChain.sol`)** organizado logicamente nos três registros | Reduz complexidade de deploy e configuração mantendo a mesma separação de dados e regras on-chain. |
| Governança via multi-sig 3-of-5 com time-lock | **Endereço único de governança** + endereço separado de recuperação (`recoverySigner`) por emissor | Preserva a separação de papéis (operador vs. emissor vs. recuperação) sem exigir infraestrutura de multi-sig externa. |
| Relayer como serviço backend + HSM | **EIP-712 real validado no contrato**, com conta de Relayer operada diretamente no cliente/script | Demonstra meta-transações reais e abstração de gás sem necessidade de microsserviço ou banco de dados. |
| Backend / Banco de dados do portal | **Removido** (frontend SPA conectado direto ao RPC) | Reforça a arquitetura *holder-held* e a verificação independente de servidores. |
| Rede L2 pública | **Rede local (Hardhat) + deploy opcional em testnet L2 (Base Sepolia)** | Garante demonstração 100% confiável offline em sala e coleta de métricas reais em testnet pública. |
| SoulboundBadge (ERC-5192), cross-anchoring L1, aprovação em 2 etapas, probation caps, custodiante pós-fechamento, geração de PDF | **Fora do escopo do MVP** | Marcados como opcionais/Fase 2 no paper ou fora da matriz de avaliação do PD3. |
