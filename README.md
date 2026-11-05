# websh — un shell Linux jetable dans le navigateur

Chaque chargement de page crée un conteneur Alpine isolé et ouvre un shell dedans,
affiché avec xterm.js. Quand l'onglet est fermé (ou la connexion perdue), le conteneur
est détruit.

![Terminal websh dans le navigateur](docs/screenshot.png)

```
Navigateur (xterm.js) ──WebSocket──▶ serveur Node ──API Docker (socket)──▶ conteneur Alpine
```

## Démarrage

```bash
docker compose up -d --build
```

Le fichier compose publie le service via Caddy (labels `caddy*`) sur
`shell.int.enpos.fr` : il suppose que le réseau externe `caddy` existe et n'expose
aucun port sur l'hôte. Pour un autre domaine, adaptez les labels et `ALLOWED_ORIGINS`.

`docker compose` construit deux images : `websh-sandbox` (l'image des bacs à sable,
aucun conteneur n'est lancé pour elle) et `websh-server` (le serveur web).

Sans compose :

```bash
docker build -t websh-sandbox:latest ./sandbox
cd server && npm ci && node src/server.js
```

Le serveur écoute alors sur http://localhost:3000.

## Arborescence

```
sandbox/          image Alpine des sessions (paquets, prompt, message d'accueil)
server/src/
  server.js       HTTP + WebSocket, rate limit, heartbeat, arrêt propre
  session.js      cycle de vie d'un conteneur (création, flux TTY, resize, suppression)
  limiter.js      limite de conteneurs simultanés par client et au total
  docker.js       petit client de l'API Docker (sans dépendance)
  config.js       variables d'environnement
server/public/    page web (xterm.js)
```

## Cycle de vie d'une session

1. La page ouvre un WebSocket sur `/ws`.
2. Le serveur réserve un créneau (rate limit), crée le conteneur, s'y attache puis le démarre.
3. Les frappes vont vers le TTY du conteneur, la sortie revient au terminal ; le
   redimensionnement de la fenêtre est transmis.
4. Le conteneur est supprimé dès que :
   - l'onglet est fermé ou rechargé, ou le réseau coupe (ping toutes les 20 s) ;
   - l'utilisateur tape `exit` ;
   - la session est inactive depuis `SESSION_IDLE_SECONDS` ;
   - la durée maximale `SESSION_MAX_SECONDS` est atteinte ;
   - le serveur s'arrête.
5. Au démarrage, le serveur supprime aussi les conteneurs orphelins (label
   `websh.managed=true`) laissés par un éventuel plantage. Docker les supprime de
   lui-même s'ils s'arrêtent (`AutoRemove`).

## Rate limit

- **10 conteneurs simultanés par client** (`MAX_CONTAINERS_PER_IP`). Le client est
  identifié par son IP ; en IPv6, par son préfixe /64, puisqu'un client en dispose
  généralement d'un entier.
- **50 au total** (`MAX_CONTAINERS_TOTAL`) pour protéger la machine.
- Le créneau est réservé avant la création du conteneur et libéré seulement une
  fois le conteneur réellement supprimé : une rafale de connexions ne peut pas
  dépasser la limite.
- Au-delà, la page affiche un message et un bouton « Retry ».

## Isolation des conteneurs

| Mesure | Réglage |
| --- | --- |
| Utilisateur non root | uid 1000, bits setuid retirés de l'image |
| Aucune capability | `--cap-drop ALL`, `no-new-privileges` |
| Système de fichiers en lecture seule | seuls `/home/sandbox` et `/tmp` sont des tmpfs de 64 Mo |
| Mémoire | 256 Mo, sans swap |
| CPU | 0,5 cœur |
| Processus | 128 max (anti fork-bomb) |
| Réseau | aucun par défaut |
| Flux de sortie | contre-pression : un `yes` ne sature pas la mémoire du serveur |
| Flux d'entrée | au-delà de 1 Mo en attente, les frappes sont ignorées ; les gros collages sont découpés par le navigateur |
| WebSocket | origine vérifiée (un site tiers ne peut pas ouvrir de sessions) |

Pour une isolation plus forte, installer [gVisor](https://gvisor.dev) sur l'hôte et
définir `SANDBOX_RUNTIME=runsc`.

> ⚠️ Le serveur monte `/var/run/docker.sock`, ce qui équivaut à un accès root sur
> l'hôte. Ne l'exposez pas tel quel sur Internet sans authentification devant
> (reverse proxy avec auth, VPN…). Un shell public est une cible d'abus évidente.

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | port HTTP |
| `MAX_CONTAINERS_PER_IP` | `10` | conteneurs simultanés par client |
| `MAX_CONTAINERS_TOTAL` | `50` | conteneurs simultanés au total |
| `SANDBOX_IMAGE` | `websh-sandbox:latest` | image des sessions |
| `SANDBOX_SHELL` | `/bin/bash,-l` | commande lancée (séparée par des virgules) |
| `SANDBOX_MEMORY` | `256m` | limite mémoire |
| `SANDBOX_CPUS` | `0.5` | limite CPU |
| `SANDBOX_PIDS` | `128` | nombre max de processus |
| `SANDBOX_TMP_SIZE` | `64m` | taille de `/tmp` et du home |
| `SANDBOX_NETWORK` | `none` | réseau Docker des sessions |
| `SANDBOX_RUNTIME` | – | runtime OCI (ex. `runsc`) |
| `SESSION_MAX_SECONDS` | `1800` | durée de vie max d'une session |
| `SESSION_IDLE_SECONDS` | `600` | fermeture après inactivité (0 = jamais) |
| `TRUST_PROXY` | `false` | lire l'IP cliente dans `X-Forwarded-For` |
| `ALLOWED_ORIGINS` | – | origines autorisées, séparées par des virgules (par défaut : même hôte) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | socket Docker |

### Donner Internet aux sessions

Par défaut les sessions n'ont pas de réseau (`curl`, `git clone`… échouent). Pour
l'activer, créez un réseau dédié et désignez-le :

```bash
docker network create websh-sandbox
# puis dans docker-compose.yml : SANDBOX_NETWORK: websh-sandbox
```

Les visiteurs pourront alors joindre Internet **et** votre réseau local. Filtrez avec
iptables (chaîne `DOCKER-USER`) si vous l'activez.

### Paquets préinstallés

Modifiez la liste `apk add` dans `sandbox/Dockerfile`, puis `docker compose build`.
Les visiteurs ne peuvent pas installer de paquets eux-mêmes (pas de root, système
en lecture seule).

## Derrière un reverse proxy

Le `docker-compose.yml` fourni active déjà `TRUST_PROXY` pour Caddy. Avec nginx :

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
}
```

Et `TRUST_PROXY: "true"` côté serveur, sinon toutes les connexions semblent venir de
du proxy et partagent la même limite de 10. N'activez cette option que si le serveur
est joignable uniquement via le proxy, car l'en-tête peut sinon être forgé.
