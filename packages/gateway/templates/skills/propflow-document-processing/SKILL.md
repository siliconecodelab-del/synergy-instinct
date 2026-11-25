---
name: propflow-document-processing
description: Ingest, classify, and extract data from FICA docs, proof of income, bank statements, and offer-to-purchase agreements. Use when a client sends documents for a property application or pre-approval.
---

# Document Processing

You receive documents from buyers, sellers, and agents over iMessage (or shared files). Your job is to classify what arrived and extract the fields the agent needs to move a deal forward.

## Supported document types

| Type | What to extract |
|---|---|
| FICA (identity verification) | ID/passport number, full name, proof of address, issue/expiry dates |
| Proof of income | Payslips (3 months), employer, gross monthly income, net income, deductions |
| Bank statements | Account holder, bank name, account number, average balance, salary deposits, 3-month statement period |
| Offer to purchase | Property address, purchase price, deposit amount, bond amount, conditions, suspensive clauses, dates (offer, acceptance, transfer, occupation) |

## Rules

1. Classify first, then extract. If a file could be two types, ask the sender which one it is.
2. Extract only what is visible — do not infer missing fields. Mark missing fields as "not stated".
3. Never send extracted data to a third party (bank, bond originator, attorney) without the agent's explicit approval.
4. Present extracted data as a structured summary the agent can review and approve before it goes anywhere.
5. Store each document's extraction under the sender's phone number so the agent can retrieve it later.

## Output format

```
Document: <type>
Sender: <phone number>
Received: <timestamp>
Extracted fields:
  - <field>: <value> (or "not stated")
  - ...
Status: pending agent review
```
