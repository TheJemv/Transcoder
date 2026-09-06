# Nimly Transcoder

Servicio self-hosted que transcodifica los MP4 de los posts de Nimly a **HLS VOD**
y los sirve por una API chiquita autenticada, para hacer streaming real en vez de
progressive download. Todo corre en tu infra. **Cero terceros.**

- **Worker** — escucha `LISTEN transcode_job` (+ poll de respaldo), baja el MP4
  original del bucket privado `media`, corre `ffmpeg` → HLS 720p, sube a
  `media-hls`, y marca `posts.playback_status = 'ready'`.
- **Media API** (Fastify) — `GET /media/:userId/:postId/index.m3u8`: verifica el
  access token de Supabase (local, sin red), chequea permiso con un query
  indexado, y devuelve el playlist con los segmentos ya firmados.

Un contenedor, dos procesos, enganchado a la red docker de Supabase.

---

## 1. Prerequisitos

- Supabase self-hosted corriendo por docker-compose (Postgres + Storage + Kong).
- Docker + Docker Compose en el server.
- Acceso `psql` a la BD de Supabase (para correr la migración).
- Un Cloudflare Tunnel ya configurado para `supabase.<dominio>` (le vamos a
  agregar `media.<dominio>`).
- El `SERVICE_ROLE_KEY` y el `SUPABASE_JWT_SECRET` del `.env` de tu Supabase.

---

## 2. Estructura del repo

```
.
├── docker-compose.yml         # 1 servicio `transcoder`, red externa de Supabase
├── Dockerfile                 # node:20-slim + ffmpeg (Debian: libx264 + libzimg)
├── .env.example               # copiar a .env
├── sql/
│   └── 001_hls.sql            # migración idempotente
├── scripts/
│   └── enqueue-test.ts        # encola un job para un post existente
└── src/
    ├── config.ts              # todo desde env
    ├── logger.ts              # logs JSON, sin PII
    ├── db.ts                  # pool de pg
    ├── jwt.ts                 # verificación HS256 + exp (jose)
    ├── storage.ts             # Storage de Supabase por REST (fetch)
    ├── start.ts               # supervisor: worker + api
    ├── worker/
    │   ├── index.ts           # LISTEN + poll + claim (FOR UPDATE SKIP LOCKED)
    │   ├── ffmpeg.ts          # args de ffmpeg + probe HDR
    │   ├── transcode.ts       # pipeline de transcode
    │   └── cleanup.ts         # borrado de media-hls/{user}/{post}/
    └── api/
        ├── index.ts           # rutas Fastify
        └── permissions.ts     # el query de permiso
```

> **Nota:** no usamos `@supabase/supabase-js`. Su cliente instancia Realtime en el
> constructor y en Node 20 (sin `WebSocket` global) revienta. El Storage se usa por
> REST directo con `fetch` — la superficie que necesitamos (download / upload /
> sign / list / remove) es chica y estable.

---

## 3. Orden de setup (server)

### 3.1 Correr la migración

Desde `~/projects/supabase/docker` (el puerto 5432 del host lo tiene el pooler,
así que lo más simple es entrar al contenedor `db`):

```bash
docker compose exec -T db psql -U postgres -d postgres < /ruta/a/Transcoder/sql/001_hls.sql
```

Crea `transcode_jobs`, agrega `hls_path` / `playback_status` a `posts` (y
`stories`), crea el bucket privado `media-hls`, los triggers de encolado/limpieza,
y agrega las dos columnas nuevas a la view `posts_with_stats`. **Es idempotente:**
se puede correr de nuevo sin romper nada.

### 3.2 Llenar `.env`

El `.env` de este repo **ya está armado para este server** (valores tomados de
`~/projects/supabase/docker/.env`). Si lo tenés que rehacer:

```ini
DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@db:5432/postgres
SUPABASE_URL=http://kong:8000
PUBLIC_SUPABASE_URL=https://supabase.platosmart.com
SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY del .env de Supabase>
SUPABASE_JWT_SECRET=<JWT_SECRET del .env de Supabase>
SUPABASE_NETWORK=supabase_default
```

> ⚠️ **Nunca** pongas secretos reales en `.env.example` (ese sí va a git). Van
> solo en `.env`, que está en `.gitignore`.

> `SUPABASE_URL` es la URL **interna** que usan worker + API para hablar con
> Storage. `PUBLIC_SUPABASE_URL` es la URL **pública** y **solo** se usa para armar
> los signed URLs de los segmentos que van dentro del playlist (los abre el
> teléfono). Si no la pones, se usa `SUPABASE_URL` — lo cual sirve para el test en
> Mac pero **rompería en el server** (el teléfono no llega a `kong:8000`).

### 3.3 Confirmar el nombre de la red docker de Supabase

```bash
docker network ls | grep supabase
```

Pon el nombre en `.env`:

```ini
SUPABASE_NETWORK=supabase_default    # <- lo que te haya salido
```

### 3.4 Levantar

```bash
docker compose up -d --build
docker compose logs -f transcoder
```

Deberías ver `worker.start`, `listen.ready`, `api.listening`.

### 3.5 Agregar la ruta en el Cloudflare Tunnel

Tu `cloudflared` corre como contenedor (`cloudflared`) en la red de Supabase con
**token** (`tunnel run`, sin `config.yml`) → las rutas se manejan en el
**dashboard de Cloudflare Zero Trust**:

*Networks → Tunnels → (tu tunnel) → Public Hostname → Add a public hostname*

| Campo | Valor |
|---|---|
| Subdomain | `media` |
| Domain | `platosmart.com` |
| Path | *(vacío)* |
| Type | `HTTP` |
| URL | `transcoder:8787` |

`transcoder` resuelve porque el contenedor está en la misma red docker
(`supabase_default`) que `cloudflared`. El DNS de `media.platosmart.com` lo crea
Cloudflare solo al guardar el public hostname.

> Si algún día pasas `cloudflared` a `config.yml`, el `ingress` equivalente es
> `- hostname: media.platosmart.com` / `service: http://transcoder:8787` antes de
> la regla `http_status:404`.

### 3.6 Prueba manual

Ver la sección **6. Prueba manual** abajo.

---

## 4. Test en tu Mac (antes de tocar el server)

El código no tiene nada hardcodeado: el mismo `tsx` corre local apuntando al
Supabase público.

### 4.1 Postgres alcanzable

El worker hace `LISTEN` sobre una conexión directa a Postgres (5432). Ese puerto
normalmente **no** está expuesto fuera del server. Elegí una:

- **Túnel SSH (recomendado):**
  ```bash
  ssh -N -L 5432:localhost:5432 usuario@tu-server
  ```
  y en `.env`: `DATABASE_URL=postgres://postgres:TU_PASS@127.0.0.1:5432/postgres`
- Exponer temporalmente el 5432 del contenedor `db` de Supabase.
- Correr un Supabase local y probar contra ese.

### 4.2 `.env` para Mac

```ini
DATABASE_URL=postgres://postgres:TU_PASS@127.0.0.1:5432/postgres
SUPABASE_URL=https://supabase.platosmart.com
# PUBLIC_SUPABASE_URL vacío -> usa SUPABASE_URL
SERVICE_ROLE_KEY=...
SUPABASE_JWT_SECRET=...
WORK_DIR=/tmp/nimly-work
```

### 4.3 Correr

```bash
npm install
npm run typecheck          # opcional
npm run worker             # una terminal
npm run api                # otra terminal
```

> **ffmpeg en la Mac:** necesitás un `ffmpeg` que funcione en el PATH. Si tenés
> Homebrew con libs desalineadas (`Library not loaded: libx265...`), corré
> `brew reinstall ffmpeg`. En el server esto no aplica: el Docker trae el ffmpeg
> de Debian. El build de Debian **sí** trae `libzimg` (zscale/tonemap) para el
> tone-map de HDR; si por lo que sea falla, el worker reintenta con el filtro
> básico automáticamente.

---

## 5. Cambio en el cliente (otro repo — Nimly app)

En `components/PostComponent/hooks/usePost.ts`, cuando
`post.playback_status === 'ready'`, la fuente del player pasa de string a objeto:

```ts
const source =
  post.playback_status === 'ready'
    ? {
        uri: `${MEDIA_API_BASE}/media/${post.user_id}/${post.id}/index.m3u8`,
        headers: { Authorization: `Bearer ${session.access_token}` },
        contentType: 'hls' as const,
      }
    : signedMp4Url; // el string de siempre
```

- `MEDIA_API_BASE = https://media.<dominio>`
- `expo-video` 57.0.3 `VideoSource` soporta `headers` y los aplica **al playlist y
  a cada segmento** (iOS `AVURLAssetHTTPHeaderFieldsKey`, Android
  `OkHttpDataSource.setDefaultRequestProperties`).
- `FullscreenVideoViewer` necesita **el mismo objeto** `source`.
- Va por **EAS Update**, sin build nativa.
- Fallback natural: si `playback_status` es `'raw'` o `'error'`, el cliente sigue
  con el MP4 crudo. Un post nunca se rompe por un transcode fallido.

---

## 6. Prueba manual

### 6.1 Encolar un job para un post que ya existe

```bash
export DATABASE_URL='postgres://postgres:TU_PASS@127.0.0.1:5432/postgres'
npm run enqueue-test -- <POST_ID>
```

Salida:

```json
{
  "enqueued_job": "…",
  "post_id": "…",
  "user_id": "…",
  "source_path": "user-id/1699…-abc.mp4"
}
```

(También podés insertar a mano:)

```sql
insert into transcode_jobs (op, kind, target_id, user_id, source_bucket, source_path)
select 'transcode','post', id, user_id, 'media', media_url
from posts where id = '<POST_ID>';
select pg_notify('transcode_job', '<POST_ID>');
```

### 6.2 Ver los logs del worker

```bash
docker compose logs -f transcoder        # server
# o la terminal donde corre `npm run worker` en la Mac
```

Secuencia esperada:

```
job.start            op=transcode kind=post attempts=1
transcode.download
transcode.ffmpeg_start   mode=basic isHdr=false
transcode.upload         segments=4
transcode.done           hlsPath=user/post/index.m3u8
job.ok                   ms=…
```

Chequeá la fila:

```sql
select status, attempts, error from transcode_jobs where target_id = '<POST_ID>';
select playback_status, hls_path from posts where id = '<POST_ID>';
```

### 6.3 `curl` al `.m3u8` con un token real

Un access token de Supabase (`session.access_token`) de un usuario que sea el
dueño o amigo del dueño:

```bash
TOKEN='eyJhbGciOi...'
POST_ID='...'
USER_ID='...'   # dueño del post

curl -s -H "Authorization: Bearer $TOKEN" \
  "https://media.<dominio>/media/$USER_ID/$POST_ID/index.m3u8"
```

Esperado: un playlist HLS con líneas `#EXTINF` y URLs absolutas
`https://supabase.<dominio>/storage/v1/object/sign/media-hls/...?token=...`.

```bash
# probar que un segmento firmado abre:
curl -s -o /dev/null -w '%{http_code}\n' "<pega-aquí-una-URL-de-segmento>"   # 200

# sin token -> 401
curl -s -o /dev/null -w '%{http_code}\n' "https://media.<dominio>/media/$USER_ID/$POST_ID/index.m3u8"

# token de alguien sin permiso -> 403
```

En local: reemplazá el host por `http://127.0.0.1:8787`.

---

## 7. Variables de entorno

| Var | Default | Qué es |
|---|---|---|
| `DATABASE_URL` | — | Postgres directo (LISTEN + queries). |
| `SUPABASE_URL` | — | URL **interna** de Supabase (worker/API → Storage). Server: `http://kong:8000`. |
| `PUBLIC_SUPABASE_URL` | = `SUPABASE_URL` | URL **pública**, solo para los signed URLs del playlist. |
| `SERVICE_ROLE_KEY` | — | service_role (bypassa RLS). |
| `SUPABASE_JWT_SECRET` | — | Para verificar los tokens de usuario (HS256 + exp). |
| `SOURCE_BUCKET` | `media` | Bucket de los MP4 originales. |
| `HLS_BUCKET` | `media-hls` | Bucket de salida HLS. |
| `MEDIA_API_PORT` | `8787` | Puerto de la Media API. |
| `SIGNED_URL_TTL` | `21600` | TTL (s) de los signed URLs de segmentos. 6h. |
| `SEGMENT_PROXY` | `false` | `true` → la API hace stream de los `.ts` (solo valida firma+exp). |
| `TARGET_HEIGHT` | `720` | Alto máximo de la rendición (no hace upscale). |
| `VIDEO_BITRATE` | `2M` | `-maxrate` (bufsize = 2×). |
| `AUDIO_BITRATE` | `96k` | AAC. |
| `X264_PRESET` | `veryfast` | preset de libx264. |
| `X264_CRF` | `23` | CRF. |
| `HLS_SEGMENT_SECONDS` | `4` | `-hls_time` y alineación de keyframes. |
| `MAX_ATTEMPTS` | `3` | Reintentos antes de `playback_status='error'`. |
| `POLL_MS` | `15000` | Poll de respaldo del worker. |
| `STALE_PROCESSING_MINUTES` | `15` | Re-toma jobs `processing` colgados. |
| `WORK_DIR` | `/tmp/work` | Dir temporal (tmpfs en docker). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `SUPABASE_NETWORK` | `supabase_default` | Nombre de la red docker externa (solo compose). |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Override del binario. |

---

## 8. Cómo funciona el transcode

1. `ffprobe` sobre el original. Si `color_transfer` es `smpte2084` (PQ) /
   `arib-std-b67` (HLG) o `color_primaries` es `bt2020` → se considera **HDR**.
2. HDR → filtro `zscale + tonemap` (Hable) → SDR BT.709. Si el proceso sale
   `!= 0` (build sin `libzimg`, filtro que falla) → **reintento con el filtro
   básico** `scale,format=yuv420p`.
3. libx264 `preset veryfast`, `profile main`, `CRF 23`, `-maxrate 2M -bufsize 4M`.
   AAC 96k estéreo (audio opcional: posts sin audio no rompen).
4. Keyframes cada `HLS_SEGMENT_SECONDS` (`-force_key_frames expr:gte(t,n_forced*4)`).
5. HLS VOD: `-hls_time 4 -hls_playlist_type vod -hls_flags independent_segments
   -hls_segment_type mpegts`. 1 sola rendición.
6. Sube `seg_*.ts` (Cache-Control `public, max-age=31536000, immutable`),
   **después** `index.m3u8`.
7. `UPDATE posts SET hls_path=…, playback_status='ready'`.

El worker procesa **1 job a la vez**. Siempre limpia `WORK_DIR/<jobId>/`.

---

## 9. Troubleshooting

| Síntoma | Causa probable / fix |
|---|---|
| `worker.start` pero nunca `listen.ready` | `DATABASE_URL` no alcanzable. En Mac: ¿el túnel SSH está arriba? En server: ¿el servicio está en la red de Supabase? (`SUPABASE_NETWORK`). |
| `listen.connect_failed … password authentication failed` | El rol `postgres` no acepta conexión TCP. Probá `supabase_admin` (misma `POSTGRES_PASSWORD`) en `DATABASE_URL`, o el pooler: `postgres://postgres.<POOLER_TENANT_ID>:<PASS>@supabase-pooler:5432/postgres` (sesión, no transacción — el pooler transaccional rompe LISTEN). |
| `network <nombre> not found` al `up` | Corré `docker network ls | grep supabase` y ajustá `SUPABASE_NETWORK` en `.env`. |
| Jobs quedan en `pending`, worker no los toma | El worker no está corriendo, o `claim.failed` en logs → revisá permisos de la conexión (`postgres` debe poder `UPDATE transcode_jobs`). |
| `job.fail … ffmpeg exit … zscale` / `tonemap` | El worker ya reintenta con el filtro básico. Si igual falla, corré `ffmpeg -filters | grep -E 'zscale|tonemap'` dentro del contenedor. El ffmpeg de Debian los trae. |
| `job.fail … storage download failed 400/404` | `source_path` mal (debe ser el path dentro del bucket `media`, = `posts.media_url`), o `SERVICE_ROLE_KEY` incorrecta. |
| Playlist da `404 not_found` | El transcode no terminó / falló. `select status, error from transcode_jobs where target_id='<POST_ID>'`. |
| `curl` al `.m3u8` da `401` | Token expirado o `SUPABASE_JWT_SECRET` no coincide con el de Supabase. |
| `curl` al `.m3u8` da `403` | El `sub` del token no es dueño ni amigo del dueño, o hay bloqueo entre ambos. |
| Segmentos del playlist apuntan a `http://kong:8000/...` | Falta `PUBLIC_SUPABASE_URL` en `.env` (server). |
| El cliente reproduce el playlist pero los segmentos dan 401/403 | El signed URL expiró (subí `SIGNED_URL_TTL`) o `expo-video` no propaga headers — con `SEGMENT_PROXY=false` **no hacen falta** headers en los segmentos (van firmados en la URL). |
| Post borrado pero el HLS sigue en Storage | El job `cleanup` falló o el post no tenía `hls_path` cuando se borró. Revisá `transcode_jobs where op='cleanup'`. |
| `CREATE VIEW` falla por dependencia de otra función | Además de `get_friends_posts`, tenés otra función que devuelve `SETOF posts_with_stats`. Dropeala, corré la migración, recreala. |
| ffmpeg en Mac: `Library not loaded: libx265` | Homebrew desalineado: `brew reinstall ffmpeg`. No afecta al server. |

---

## 10. Stories

La migración ya deja `hls_path` / `playback_status` en `stories` y los triggers
**comentados** en `sql/001_hls.sql` (sección 6b). Para activarlos: descomentar esa
sección, correr la migración de nuevo, y listo — el worker ya maneja
`kind='story'` (usa la tabla `stories` para el `UPDATE` y el mismo bucket
`media-hls`).
