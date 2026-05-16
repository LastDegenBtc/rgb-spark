# sprk.fun — Pitch trader

Arguments commerciaux face à Solana / pump.fun, formulés en
trader-language. Pour Twitter, decks, ou pitch direct.

> **TL;DR.** Pump.fun a montré que les memecoins retail c'est massif.
> Mais Solana a 3 problèmes structurels que les traders subissent tous
> les jours : le MEV qui te sandwich, les devs qui peuvent rugger via
> mint authority, et la chain qui halt. sprk.fun c'est pump.fun mais
> sur Bitcoin, sans MEV, sans rug possible, sans halt — et tu PnL en
> sats au lieu de SOL.

---

## Les 5 douleurs trader Solana → arguments sprk.fun

### 1. Le rug

| | |
|---|---|
| **Pain Solana** | "J'ai acheté un token, le dev a freeze le mint, dumpé sa bag, j'étais coincé." |
| **Argument sprk.fun** | Sur RGB il n'y a **pas de mint authority**, **pas de freeze function**, **pas de contract upgrade**. Le dev peut rien faire. Une fois l'asset issued, ses pouvoirs = zéro. |

**Pourquoi ça tue** : c'est littéralement impossible à reproduire sur
Solana. Les SPL tokens *ont* ces autorités par défaut. Même Bonk, même
Wif. Le dev *peut* freezer. Sur RGB c'est pas "le dev promet de pas le
faire" — c'est "le bouton n'existe pas".

> **One-liner** — *Pump.fun te demande de faire confiance au dev.
> sprk.fun te demande pas.*

---

### 2. Le sandwich / MEV

| | |
|---|---|
| **Pain Solana** | "Chaque achat je me prends un sandwich, Jito me bouffe 3-5% de slippage à chaque trade." |
| **Argument sprk.fun** | **Pas de mempool public**. **Pas de validators qui réordonnent**. Ton ordre matche directement avec un counterparty, point. Personne peut s'insérer. |

**Pourquoi ça tue** : c'est chiffrable. Les traders savent combien le
MEV leur coûte. Solana a même *institutionnalisé* le MEV avec Jito.
Sur Spark t'as un orderbook + HTLC bilatéral, y'a pas de surface
d'attaque pour le sandwich.

> **One-liner** — *Zéro MEV. Zéro Jito. Zéro bot qui te bouffe ton entry.*

---

### 3. La chain qui tombe

| | |
|---|---|
| **Pain Solana** | "Solana a halté 6 fois en 2024, j'étais long pendant 4h sans pouvoir sortir." |
| **Argument sprk.fun** | On est sur **Bitcoin**. Bitcoin a jamais halté en 16 ans. Spark se relance même si la moitié des opérateurs tombent. |

**Pourquoi ça tue** : c'est viscéral. Tout trader Solana a vécu un halt
et a chié dans son froc. Bitcoin = uptime. Pas de débat.

> **One-liner** — *La chain ne tombe pas. Tes positions ne sont pas
> otages d'un validator gang.*

---

### 4. La denomination

| | |
|---|---|
| **Pain Solana** | "J'ai fait +40% sur ce shitcoin, mais SOL a dumpé 30% pendant ce temps, je suis net flat." |
| **Argument sprk.fun** | Tu trades **en sats**. Tes PnL sont **en BTC**. Pas de devise intermédiaire qui te déprécie pendant que tu farm. |

**Pourquoi ça tue** : c'est la réalité 2024-2026. Les traders Solana
qui ont swappé en SOL au lieu de USDC se sont fait niquer. Pricing en
sats = pricing dans la seule chose qui monte.

> **One-liner** — *Tu farm des sats, pas du SOL-qui-dumpe.*

---

### 5. Le wallet de daron

| | |
|---|---|
| **Pain Solana** | "Phantom est un chrome extension, j'ai déjà perdu des fonds à un fake popup, et c'est galère sur mobile." |
| **Argument sprk.fun** | **PWA mobile-first**. Tu trades depuis ton iPhone. Pas de chrome extension, pas de seed phrase que tu tapes à la main à chaque fois. |

**Pourquoi ça tue** : pump.fun mobile est catastrophique. Phantom mobile
non plus. Tu prends l'iPhone Safari par défaut, t'es déjà supérieur en
UX.

> **One-liner** — *Pump.fun c'est un jeu desktop. sprk.fun c'est un
> wallet dans ta poche.*

---

## Les 3 arguments à mettre en tête de pitch

Si tu peux pas placer plus de 3 points dans un thread Twitter ou un
elevator pitch :

1. **No rug possible** — technique, chiffrable, viral
2. **No MEV** — technique, chiffrable, viral
3. **Sur Bitcoin** — émotionnel, identitaire, branding

Les deux premiers sont rationnels (un trader peut les vérifier dans
les 30 secondes). Le troisième est tribal (Bitcoin maximalists
amplifient gratuitement).

---

## Les angles à éviter

| Angle | Pourquoi pas |
|---|---|
| **Privacy / anonymat** | Le trader-board reste public sur sprk.fun. Si tu tapes sur la transparence Solana, ça se retourne contre toi. |
| **Décentralisation pure** | Spark = fédération. Si tu dis "Solana est trop centralisé", on répond "et toi ?". |
| **Speed / throughput** | Solana est plus rapide en TPS brut. Pas un terrain où on gagne. |
| **Frais** | Solana est quasi-gratos. Spark aussi mais c'est pas knockout. |

---

## Pitch synthétique 3-phrases

> *Pump.fun a montré que les memecoins retail c'est massif. Mais
> Solana a 3 problèmes structurels que les traders subissent tous les
> jours : le MEV qui te sandwich, les devs qui peuvent rugger via mint
> authority, et la chain qui halt. sprk.fun c'est pump.fun mais sur
> Bitcoin, sans MEV, sans rug possible, sans halt — et tu PnL en sats
> au lieu de SOL.*

---

## Variations one-liner pour Twitter

- *Pump.fun te demande de faire confiance au dev. sprk.fun te demande pas.*
- *Zéro MEV. Zéro Jito. Zéro bot qui te bouffe ton entry.*
- *La chain ne tombe pas. Tes positions ne sont pas otages d'un validator gang.*
- *Tu farm des sats, pas du SOL-qui-dumpe.*
- *Pump.fun c'est un jeu desktop. sprk.fun c'est un wallet dans ta poche.*
- *Memecoins sur Bitcoin. Sans rug, sans MEV, sans halt.*
