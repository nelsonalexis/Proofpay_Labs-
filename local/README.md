# ProofPay

MVP pour le Track 3 RWA de l’Italian XRPL Hackathon. Un restaurant commande un logo à une agence pour 100 XRP de test. L’agence doit 80 XRP au graphiste. ProofPay prépare deux chemins de règlement pour les mêmes créances.

| Circuit | Opération 1 | Opération 2 |
| --- | --- | --- |
| Normal | Restaurant → Agence, 100 XRP | Agence → Graphiste, 80 XRP |
| Secours | Restaurant → Graphiste, 80 XRP | Restaurant → Agence, 20 XRP |

Dans les deux cas, hors frais, le restaurant dépense 100 XRP, l’agence conserve 20 XRP et le graphiste reçoit 80 XRP. Les deux règlements sont indivisibles au sein de chaque lot. Seul le premier circuit validé peut racheter les créances via les offres préparées.

## Lancer

Avec Node.js 22 ou plus récent, npm et curl :

```bash
npm ci
npm start
```

Ouvrir [ProofPay en local](http://127.0.0.1:4173). Le serveur écoute seulement sur la boucle locale. Il démarre en simulation. Pour de vrais tests XRPL, sélectionner **XRPL Testnet**, puis **Nouveau scénario**. Le faucet doit être accessible. L’initialisation crée trois comptes financés, deux NFT et six offres. Elle peut prendre plusieurs dizaines de secondes. Le scénario et les clés de test sont en mémoire. Un redémarrage réinitialise la démo.

## Activer les agents IA

Depuis le dossier du projet, avec Node.js, npm et curl :

```bash
npm ci
npm run model:download
npm start
```

Le téléchargement récupère Qwen2.5-0.5B-Instruct au format GGUF (~490 Mo) et vérifie son SHA-256. Le modèle tourne localement sur CPU avec node-llama-cpp, sans clé API. Pour utiliser un fichier compatible déjà téléchargé, lance le serveur avec `PROOFPAY_MODEL=/chemin/modele.gguf npm start`. Les boutons manuels permettent toujours de rejouer les contrôles à règles.

En mode testnet, les deux agents ont des identités XRPL distinctes. Utilise **Consulter l’agent Agence** ou **Consulter l’agent Restaurant** selon le circuit à explorer. Le modèle reçoit l’état du circuit, l’accord et les offres lues par le serveur. Il génère une proposition parmi les plans déclarés conformes par l’outil, ou une décision d’attente, avec une explication. Le test de secours présente notamment deux offres qui totalisent 100 XRP, avec une seule répartition conforme. Le serveur applique les règles indépendamment. Si une proposition est valide, l’utilisateur confirme dans le panneau de contrôle. L’identité autorisée de l’agent signe le lot en plus du cosignataire requis par XRPL.

Le lot inclut dans ses métadonnées le SHA-256 de la décision. Le document de décision est téléchargeable depuis l’interface. Son empreinte peut être comparée au mémo du lot validé et l’adresse de l’agent figure parmi les signataires publics. L’inférence s’exécute hors chaîne. La signature authentifie l’engagement de l’agent sur ce document et ce lot, sans prouver l’exécution du modèle sur le registre. Télécharge les décisions que tu souhaites conserver avant de réinitialiser le scénario.

```bash
npm run verify:agents
npm run verify:agents -- --testnet
npm run verify:agents -- --testnet --normal
```

Les deux variantes testnet relisent indépendamment le lot validé sur XRPL et vérifient le mémo et l’identité de l’agent signataire. Le scénario de secours vérifie aussi que le processus principal est effectivement arrêté, que le secours garde son PID, puis que la relance ne déclenche aucun versement.

## Démo jury

1. Initialiser le testnet et montrer les deux créances et leurs factures JSON téléchargeables.
2. Cliquer sur **Arrêter l’agent principal**. Le processus Node de l’agent normal est effectivement arrêté. Son PID disparaît et celui du secours reste identique. Les offres de secours ont déjà été émises.
3. Cliquer sur **Tester 85 + 15 XRP**. La répartition s’écarte des deux montants convenus malgré un total de 100 XRP. La proposition est refusée avant signature.
4. Cliquer sur **Consulter l’agent Restaurant**, examiner la décision et les **80 + 20 XRP**, puis **Cosigner et régler**. Ouvrir le lot dans l’explorateur et retrouver le signataire et le mémo de la décision.
5. Cliquer sur **Relancer l’agent principal**. Son nouveau processus conserve la même identité de signature pour la session. Cliquer sur **Retenter l’autre circuit**. La démonstration soumet un nouveau lot avec les offres initiales. Le registre n’applique aucun versement supplémentaire.
6. Télécharger la preuve JSON du testnet depuis le journal. Elle rassemble les deux identités, les identifiants des factures et jetons, les arrêts et reprises observés, le lot réglé et la relance éventuelle. Sur un scénario neuf, tester le **circuit normal**. Sur un autre, arrêter l’agent principal puis choisir **Tester l’annulation du lot**. Ce bouton annule volontairement l’offre à 20 XRP après la préparation du lot de démonstration. Vérifier que les variations des trois soldes sont nulles hors frais.

> “The agency’s payment service goes offline. The restaurant settles the same two invoices directly. The freelancer gets 80, the agency keeps 20, and neither invoice can be settled twice through the original offers.”

## Architecture

- **RWA.** Chacune des deux créances commerciales fictives a un NFT natif. Son URI contient le SHA-256 des octets exacts de sa facture JSON. Le testnet confirme la création des jetons et permet de vérifier leurs URI.
- **XRPL.** Les offres de vente sont réservées aux comptes payeurs concernés. Chaque lot utilise `BatchV1_1`, le mode `tfAllOrNothing` et deux opérations `NFTokenAcceptOffer`. Le backend vérifie les deux transactions internes et les variations de soldes. Le code de succès du lot externe à lui seul indique que le registre a traité l’enveloppe.
- **glassGrade.** L’écran examine les offres et compare les deux versements à l’accord. Le cosignataire revérifie la correspondance avec les offres et les comptes du lot exact au moment de signer.
- **Carbs.** Les orchestrateurs Agence et Restaurant utilisent deux clés distinctes. Sur le compte du restaurant, chaque clé d’agent a un poids de 1, le cosignataire a un poids de 2 et le quorum vaut 3. Le compte de l’agence exige également deux signatures. Les clés principales de ces deux comptes sont désactivées après l’initialisation.
- **Agents.** Les deux agents appellent le même modèle génératif local avec des rôles distincts. Ils proposent des offres et expliquent leur choix. Le cosignataire suit des règles déterministes. Chaque agent possède son propre processus local d’inférence. Le serveur coordonne les propositions et les clés de signature du MVP. Les deux sont isolés par processus sur la même machine de démonstration. Le circuit de secours fonctionne sans signature du compte de l’agence au moment du paiement.
- **Périmètre.** Les factures illustrent des créances fictives. Les deux scénarios exécutent des transactions XRPL avec des XRP de test uniquement. Chaque partie conserve ses fonds dans son propre compte jusqu’au règlement. L’accord de démo modélise une autorisation préalable du circuit de secours.

## Vérifier

```bash
npm test
npm run verify:testnet
```

Le premier test exerce l’API locale et compare les empreintes des documents. Le second initialise deux scénarios sur le XRP Ledger Testnet, puis vérifie le refus de 85 + 15, l’annulation complète, les règlements normal et de secours, et les relances sans versement. Il requiert l’accès au réseau et des XRP de test fournis par le faucet.

Documentation XRPL : [Batch](https://xrpl.org/docs/references/protocol/transactions/types/batch), [lots multi-comptes](https://xrpl.org/docs/tutorials/best-practices/transaction-sending/send-a-multi-account-batch-transaction), [offres NFT](https://xrpl.org/docs/references/protocol/transactions/types/nftokencreateoffer).


## Impact à valider auprès d’une équipe de paiement

Le MVP démontre qu’un règlement peut aboutir pendant l’arrêt du processus principal. Pour mesurer la valeur métier, faire préciser à une agence ou un prestataire de paiement la fréquence des règlements bloqués, le délai moyen de reprise et l’entité habilitée à utiliser le circuit de secours. Les mesures d’un pilote seraient le délai entre blocage et règlement, le taux de versements exécutés dans le délai convenu et le nombre de relances sans transfert supplémentaire. Les essais testnet mesurent le comportement du prototype, indépendamment de l’adoption métier.
