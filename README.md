# ProofPay

A backup settlement route for tokenized receivables on the XRP Ledger. Built for IXH26, Track 3.

A client owes an agency 100 XRP and the agency owes a freelancer 80 XRP. The normal route pays the agency and then the freelancer. If the agency's payment process is unavailable, the backup route pays 80 XRP to the freelancer and 20 XRP to the agency. Both routes use the same two native NFTs. Each XRPL Batch transfers both receivables and settles both payment legs atomically.

## Run the jury build

Requires Node.js 24. The app opens in simulation. Select **Démarrer sur le Testnet** to create disposable Testnet accounts and run the live workflow.

```sh
node worker/build.mjs
node worker/serve.mjs
```

Open <http://127.0.0.1:4173>. The Testnet workflow needs access to the XRPL public RPC endpoints and faucet.

## Source

| Path | Contents |
| --- | --- |
| [dist/](dist/) | Mobile UI, settlement logic, browser AI agents, trained model weights and Testnet proof JSON |
| [worker/](worker/) | HTTP API relay, local preview, host build, and model training |
| [validation/](validation/) | AI baseline comparison and XRPL Testnet outage and concurrency checks |
| [local/](local/) | Standalone Node.js MVP with process-isolated agents and optional local model |

The client account uses weighted XRPL multisigning. Each route agent has its own signing identity and requires a reviewer to reach quorum. The desktop and mobile versions use different model runtimes. See their respective source and verification commands.

## Test results

- [Backup settlement after the primary process stopped](https://testnet.xrpl.org/transactions/54C6923A1A626DE96A7DDD5A0D5B100D46349F82D5FD8076341F83D8EAC2F6F8)
- [Winning batch from concurrent submissions](https://testnet.xrpl.org/transactions/11E330D2D4198469D651DAC58BF04DDF1F401C06AF26C4286A45EF4373CF48BC)
- [Retry with zero additional payout](https://testnet.xrpl.org/transactions/46614385CFD6383C84C1AD27F74F0CE485FA7AC3A80C93F19C73896DC0093F58)

Run the deterministic model comparison with `node validation/compare-model.mjs`. See [Testnet verification](validation/README.md) for the live checks. The included proofs use Testnet transactions and demo invoices.
