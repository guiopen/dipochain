# Ajustes Técnicos em Relação ao Technical White Paper (PD2)

Este documento registra as incongruências e lacunas técnicas encontradas no *Technical White Paper* (PD2) do DiploChain e as correções aplicadas na implementação do MVP (PD3). As simplificações de escopo entre o MVP e o produto final estão documentadas em [ESCOPO_MVP.md](./ESCOPO_MVP.md).

## 1. Isolamento de revogação por emissor

Na Seção 4.3 do white paper, o `AnchorRegistry` armazena apenas a raiz de Merkle (`root`) do lote, enquanto `RevocationRegistry.revoke(issuerId, leafHash, reasonCode, issuerSig)` grava o registro de revogação diretamente na chave `leafHash`. Como o contrato não armazena as folhas individuais, ele não consegue confirmar a qual emissor o `leafHash` pertence. Se um emissor B obtiver o `leafHash` de uma credencial emitida por A, ele conseguiria gravar uma revogação nesse hash.

Para corrigir o problema, o mapeamento de revogação no contrato foi indexado pelo par `(issuerId, leafHash)`. Assim, cada emissor escreve apenas no próprio espaço de revogação, sem exigir o envio de prova de Merkle na transação de revogação.

## 2. Conversão entre DID, verificationMethod e bytes32

A interface Solidity da Seção 4.3 recebe `bytes32 issuerId` e `bytes32 keyId`, enquanto o JSON da *Verifiable Credential* (VC) na Seção 4.4 representa esses campos como strings (`issuer` e `proof.verificationMethod`). O documento não especifica como converter as strings para `bytes32`.

Na implementação, os dois identificadores são derivados deterministicamente com `keccak256` sobre os bytes UTF-8 das strings (`issuerId = keccak256(issuer)` e `keyId = keccak256(proof.verificationMethod)`). Dessa forma, qualquer verificador resolve o emissor e a chave no contrato usando apenas o arquivo JSON da credencial.

## 3. Formato da assinatura da credencial

O exemplo de VC na Seção 4.4 usa `proofValue` em formato ASN.1 DER (`0x3045...`). Contratos Solidity e bibliotecas EVM trabalham nativamente com assinaturas ECDSA secp256k1 compactas de 65 bytes (`r, s, v`).

A implementação adota assinaturas secp256k1 compactas de 65 bytes sobre o `VC_core` canonicalizado via RFC 8785 (JCS). A garantia criptográfica permanece a mesma, com compatibilidade direta com `ethers.js` e `ecrecover`, evitando dependências adicionais de codificação ASN.1.

## 4. Ordenação de pares na árvore de Merkle

O campo `anchorReference.merkleProof` na Seção 4.4 é uma lista simples de hashes, sem metadados de posição (esquerda ou direita) para cada nó irmão. Sem uma regra fixa de ordenação, o verificador não sabe em qual ordem concatenar os pares para recompor a raiz.

A árvore de Merkle foi implementada com pares ordenados lexicograficamente antes da aplicação de `keccak256`, seguindo o padrão da OpenZeppelin. Esse formato funciona com a lista simples de hashes especificada no white paper e trata lotes unitários como árvores de uma folha (`merkleProof` vazio e `merkleRoot` igual a `leafHash`).

## 5. Funções e campos omitidos na especificação

A interface `IDiploChainRegistries` na Seção 4.3 declara `anchor`, `revoke` e `reportCompromise`, mas omite operações exigidas pelos cenários de avaliação da Seção 12 (PD3), como o registro de emissores, a alteração de status (`Suspended` no cenário N4 e `Closed` para `VALID - ISSUER CLOSED`), a rotação de chaves e o armazenamento do endereço de recuperação (`recoverySigner`). Além disso, o exemplo de JSON da VC na Seção 4.4 omite o campo `validUntil`, necessário para validar o cenário N7 (`EXPIRED`).

O contrato `DiploChain.sol` implementa as funções `registerIssuer`, `setIssuerStatus`, `rotateKey`, `anchor`, `revoke` e `reportCompromise` (com suporte a `estimatedTime` retroativo para testar o cenário N5), além de controle de `nonce` por emissor para evitar replay de assinaturas EIP-712. No JSON da VC, foi incluído o campo opcional `validUntil` no padrão ISO-8601 (W3C VC 2.0).

## 6. Posição do salt no cálculo do leafHash

Na Seção 4.4, a fórmula define `leafHash = keccak256(salt || canonical(VC_core))`, ao mesmo tempo em que inclui o campo `salt` dentro do JSON de `VC_core`.

Para manter aderência exata ao documento e garantir que emissor e verificador produzam o mesmo hash, a implementação remove apenas `proof` e `anchorReference` antes da canonicalização JCS e concatena os bytes do `salt` antes do JSON canonicalizado.

## 7. Código de motivo no exemplo de revogação

A Seção 5.3 descreve uma revogação registrada com o motivo `issuer error`, mas afirma que o verificador exibe `REVOKED - superseded`. Como `IssuerError` e `Superseded` são valores distintos na enumeração `RevocationReason`, o verificador foi implementado para exibir exatamente o código de motivo gravado no contrato.

## 8. Tamanho do QR Code para credenciais autossuficientes

Uma VC completa em JSON, contendo payload, assinatura e prova de Merkle, ocupa entre 800 e 1.200 bytes, o que produz um QR Code denso quando codificado em texto puro.

No MVP, o verificador aceita o envio do arquivo `.json` e também links de QR Code com o JSON codificado em base64url no parâmetro de URL (`?vc=...`), preservando o armazenamento da credencial sob controle do titular, sem servidor intermediário.
