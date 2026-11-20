# Vérifier ProofPay sur le Testnet

Node.js 24 suffit. Les scripts créent des comptes jetables. Ils nécessitent un accès réseau au Testnet et à son faucet.

```sh
node worker/build.mjs
node validation/compare-model.mjs
node validation/verify.mjs outage /tmp/proofpay-outage.json
node validation/verify.mjs race /tmp/proofpay-race.json
```

Le test de panne génère les clés de signature dans trois processus Node.js distincts. L’orchestrateur reçoit leurs adresses, puis des signatures au fil de l’essai. Après SIGKILL du principal, il attend la sortie du processus, vérifie que ses appels échouent, obtient la décision et la signature du secours ainsi que la signature du cosignataire. Il relit les opérations validées, les soldes, les signataires et le mémo.

Le test concurrent signe deux lots différents avec la même séquence de compte du restaurant, puis appelle deux soumissions en parallèle. Il vérifie la séquence validée, les résultats des opérations internes et les soldes. Il resoumet ensuite l’autre circuit avec une séquence fraîche pour vérifier séparément qu’une relance avec les offres d’origine ne règle rien. Le hash du lot concurrent écarté reste un identifiant de soumission et peut être absent de l’explorateur.

Ce banc de test s’exécute sur un seul hôte. Le cosignataire du banc détient sa clé dans un autre processus et signe sur ordre du programme de test. En mode mobile les clés sont en mémoire du navigateur et l’utilisateur approuve la cosignature. Aucun de ces parcours ne constitue un déploiement à clés détenues par des entreprises indépendantes.

Les sorties contiennent des identifiants publics du Testnet et des observations de test. Elles ne contiennent pas les clés privées. Les données du comparateur IA sont synthétiques et couvrent les entrées du modèle, y compris les petits écarts de montants négligés par les données d’entraînement.
