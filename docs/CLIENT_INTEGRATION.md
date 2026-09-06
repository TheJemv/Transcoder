# Nimly — Integración del cliente con el Transcoder HLS

Contexto para trabajar el cambio en la app (React Native / Expo SDK 57).
El backend ya está desplegado y funcionando. Esto describe **solo lo que cambia
en el cliente**.

---

## Qué es

Hay un servicio self-hosted (`https://media.platosmart.com`) que transcodifica los
videos de los posts a **HLS VOD** y sirve el playlist autenticado. Antes la app
hacía *progressive download* de un MP4; ahora, para los posts ya transcodeados,
hace **streaming HLS real**.

- El MP4 original **sigue existiendo** en el bucket `media` y sigue siendo el
  fallback. Un post **nunca** se rompe por un transcode fallido o pendiente.
- Todo self-hosted, cero terceros (no Mux, no Cloudflare Stream).

---

## Lo único que cambió en la base de datos

Las tablas `posts` **y `stories`** tienen 2 columnas nuevas. En `posts` ya están
expuestas por `posts_with_stats` y `get_friends_posts` (o sea: **ya te llegan en
el feed sin cambiar queries**). En `stories` están directo en la tabla.

| Columna | Tipo | Valores |
|---|---|---|
| `playback_status` | `text` | `'raw'` (default) · `'ready'` · `'error'` |
| `hls_path` | `text` \| null | ej. `15b84370-.../7e9e4c3d-.../index.m3u8` |

Ciclo de vida:

```
post nuevo con video  ->  playback_status = 'raw'   (se encola transcode automático)
   ~segundos después  ->  playback_status = 'ready'  (hls_path seteado)
   si falla 3 veces   ->  playback_status = 'error'
```

**Regla del cliente:** usás HLS **solo** si `playback_status === 'ready'`. En
`'raw'` y `'error'` seguís con el signed URL del MP4 de siempre.

`hls_path` **no lo necesitás** en el cliente — la URL se arma con `user_id` +
`id` (abajo).

---

## Stories

Mismo mecanismo, misma forma de URL. Aplica **solo** a stories con
`media_type === 'video'`.

```
GET https://media.platosmart.com/media/{story.user_id}/{story.id}/index.m3u8
```

- Visibilidad server-side: **dueño, o amigo Y la story tiene < 24h**. Pasadas las
  24h un no-dueño recibe **403** (pero la app ya oculta las stories vencidas).
- `story_views` / view-once: se sigue manejando en el cliente como hoy — el
  servicio no lo toca.
- Al borrarse/expirar la story, el HLS se limpia solo.

## El endpoint

```
Posts:    GET https://media.platosmart.com/media/{post.user_id}/{post.id}/index.m3u8
Stories:  GET https://media.platosmart.com/media/{story.user_id}/{story.id}/index.m3u8
          Authorization: Bearer {supabase session.access_token}
```

- **200** → devuelve el playlist `.m3u8` (`application/vnd.apple.mpegurl`).
  Los segmentos dentro del playlist ya vienen como **signed URLs de Supabase
  Storage** (TTL 6h), servidos directo por Supabase — no pasan por este servicio.
- **401** → falta el token, está vencido, o es inválido.
- **403** → el usuario del token no es el dueño **ni** amigo del dueño, o hay un
  bloqueo entre ellos. (El permiso se chequea server-side; misma lógica que el
  feed.)
- **404** → todavía no está transcodeado (no debería pasar si filtraste por
  `playback_status === 'ready'`, pero puede haber una carrera).

`Cache-Control: private, no-store` — no cachear el playlist.

Health check: `GET https://media.platosmart.com/health` → `{"status":"ok"}`.

---

## El cambio de código

### `components/PostComponent/hooks/usePost.ts`

Hoy la fuente del player es un `string` (el signed URL del MP4). Pasa a ser un
`VideoSource` objeto **solo** cuando hay HLS:

```ts
import type { VideoSource } from 'expo-video';

const MEDIA_API_BASE = 'https://media.platosmart.com';

// `post` viene del feed (ya trae playback_status).
// `session` es la sesión de Supabase (useAuth / supabase.auth.getSession()).
// `mp4SignedUrl` es el string que ya usás hoy.

const videoSource: VideoSource =
  post.playback_status === 'ready'
    ? {
        uri: `${MEDIA_API_BASE}/media/${post.user_id}/${post.id}/index.m3u8`,
        headers: { Authorization: `Bearer ${session.access_token}` },
        contentType: 'hls',
      }
    : mp4SignedUrl;
```

### `FullscreenVideoViewer`

Necesita **el mismo objeto** `videoSource` (mismos `headers`). Si hoy le pasás el
string, pasale el objeto cuando `playback_status === 'ready'`.

### Stories de video

Donde reproduzcas una story de video, misma lógica:

```ts
const storySource: VideoSource =
  story.media_type === 'video' && story.playback_status === 'ready'
    ? {
        uri: `${MEDIA_API_BASE}/media/${story.user_id}/${story.id}/index.m3u8`,
        headers: { Authorization: `Bearer ${session.access_token}` },
        contentType: 'hls',
      }
    : storyMp4SignedUrl;
```

### Notas importantes

- **`expo-video` 57.0.3** soporta `headers` en `VideoSource` y los aplica **al
  playlist y a cada segmento** (iOS `AVURLAssetHTTPHeaderFieldsKey`, Android
  `OkHttpDataSource.setDefaultRequestProperties`). No hace falta nada nativo.
- **Token fresco:** el `access_token` de Supabase expira cada 1h. Derivá
  `videoSource` de forma reactiva al `session.access_token` (que se refresca solo)
  para que el objeto se reconstruya cuando rota. Si igual se cuela un token
  vencido, el peor caso es un load fallido → conviene tener el fallback al MP4 en
  el `onError` del player.
- **Segmentos:** una vez que el player cargó el playlist, los segmentos usan las
  signed URLs embebidas (válidas 6h) — no dependen del header. Una sesión de
  visualización normal entra holgada.
- **Posts recién creados:** entran como `'raw'` y el transcode tarda de segundos
  a ~1 min. El cliente muestra el MP4 hasta que el feed se refresque y traiga
  `playback_status === 'ready'`. No hace falta polling; si querés que se actualice
  en vivo, re-fetcheá el post o suscribite por Realtime a `posts`.

### Distribución

Va por **EAS Update** (JS-only). No requiere build nativa.

---

## Checklist de QA

- [ ] Post con `playback_status = 'ready'` → reproduce por HLS (verificá en
      Charles/Flipper que pide `media.platosmart.com/.../index.m3u8` y después
      `supabase.platosmart.com/storage/v1/object/sign/media-hls/...`).
- [ ] Post con `playback_status = 'raw'` o `'error'` → reproduce el MP4 de siempre.
- [ ] `FullscreenVideoViewer` reproduce igual que el player del feed.
- [ ] Video de un amigo → funciona. Video de alguien que no es amigo → el feed ya
      no lo muestra, pero si forzás la URL da 403 (esperado).
- [ ] Sesión vieja / logout → no crashea, cae al MP4 o muestra el error del player.
- [ ] Scroll largo / volver a un video después de 1h → sigue andando (o recarga
      el playlist con token nuevo).

---

## Referencia rápida

| | |
|---|---|
| Base URL | `https://media.platosmart.com` |
| Playlist | `GET /media/{user_id}/{post_id}/index.m3u8` |
| Auth | `Authorization: Bearer <session.access_token>` |
| Usar HLS cuando | `playback_status === 'ready'` (stories: además `media_type === 'video'`) |
| Fallback | signed URL del MP4 (buckets `media` / `stories`, como hoy) |
| Campo nuevo | `playback_status`, `hls_path` en `posts` y `stories` |
