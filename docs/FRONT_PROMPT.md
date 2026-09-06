# Prompt para el Claude del front

Copiá todo lo que está dentro del bloque y pegáselo en la sesión de tu app.

---

```
Contexto: el backend de Nimly ahora tiene un servicio self-hosted que transcodifica
los videos de los posts a HLS VOD y sirve el playlist autenticado. Ya está
desplegado y funcionando en https://media.platosmart.com. Necesito que integres el
cliente (React Native / Expo SDK 57, expo-video 57.0.3). Es JS-only, va por EAS
Update, sin build nativa.

── Lo que YA cambió en el backend (no tenés que tocar nada de esto) ──

1. La tabla `posts` tiene dos columnas nuevas:
   - `playback_status`: 'raw' (default) | 'ready' | 'error'
   - `hls_path`: text | null
   Ya están incluidas en las views/RPC que usa el feed (`posts_with_stats`,
   `get_friends_posts`), así que te llegan en el objeto `post` sin cambiar
   ninguna query ni tipo de request. Solo agregá los campos a los tipos TS del
   post si los tenés tipados a mano.

2. Ciclo de vida del transcode (automático):
   post nuevo con video → 'raw' → (segundos a ~1 min) → 'ready'  ó  → 'error'
   Al borrar el post, el HLS se limpia solo.

── Stories (mismo mecanismo) ──

`stories` tiene las mismas dos columnas (`playback_status`, `hls_path`) y las
mismas reglas. Solo aplica cuando `story.media_type === 'video'`. La URL usa el
MISMO shape (con story.user_id y story.id). Visibilidad server-side: dueño, o
amigo Y la story tiene menos de 24h (después de 24h un no-dueño recibe 403, pero
la app ya oculta las stories vencidas). Al expirar/borrarse la story, el HLS se
limpia solo.

── El endpoint ──

Posts:    GET https://media.platosmart.com/media/{post.user_id}/{post.id}/index.m3u8
Stories:  GET https://media.platosmart.com/media/{story.user_id}/{story.id}/index.m3u8
Header:   Authorization: Bearer {supabase session.access_token}

- 200 → playlist .m3u8 (Content-Type application/vnd.apple.mpegurl). Los
  segmentos vienen embebidos como signed URLs de Supabase Storage (válidas 6h),
  servidos directo por Supabase.
- 401 → token ausente / vencido / inválido
- 403 → el usuario no es dueño ni amigo del dueño, o hay bloqueo (mismo criterio
  que el feed; el permiso se valida server-side)
- 404 → todavía no transcodeado (no debería pasar si filtrás por 'ready')

Health: GET https://media.platosmart.com/health → {"status":"ok"}

── El cambio de código ──

Archivo: components/PostComponent/hooks/usePost.ts

Hoy la fuente del player de video es un string (el signed URL del MP4 del bucket
`media`). Cambiala a un VideoSource objeto SOLO cuando el post está transcodeado:

  import type { VideoSource } from 'expo-video';

  const MEDIA_API_BASE = 'https://media.platosmart.com';

  const videoSource: VideoSource =
    post.playback_status === 'ready'
      ? {
          uri: `${MEDIA_API_BASE}/media/${post.user_id}/${post.id}/index.m3u8`,
          headers: { Authorization: `Bearer ${session.access_token}` },
          contentType: 'hls',
        }
      : mp4SignedUrl; // exactamente el string que ya se usa hoy

Aplicá la MISMA lógica al player de stories de video (donde hoy también pasás el
string del MP4): si story.media_type === 'video' && story.playback_status ===
'ready' -> objeto VideoSource con uri
`${MEDIA_API_BASE}/media/${story.user_id}/${story.id}/index.m3u8`; si no, el MP4.

Reglas:
- SOLO usar HLS si playback_status === 'ready'. En 'raw' y 'error' se mantiene el
  MP4 de siempre. Un post/story NUNCA se debe romper ni ocultar por el estado del
  transcode.
- El componente FullscreenVideoViewer tiene que recibir EL MISMO objeto
  `videoSource` (mismos headers), no el string.
- `session.access_token` expira cada 1h (Supabase lo refresca solo). Derivá
  `videoSource` de forma reactiva al access_token para que el objeto se
  reconstruya cuando rota. Además, en el onError del player, si la fuente era
  HLS, caé al MP4 como fallback.
- No hace falta polling: si un post está en 'raw', se muestra el MP4 hasta que
  el feed se refresque con 'ready'. Si querés que se actualice en vivo, podés
  suscribirte por Supabase Realtime a la fila del post, pero es opcional.

── Verificado ──
expo-video 57.0.3 aplica los `headers` del VideoSource tanto al playlist como a
cada segmento (iOS AVURLAssetHTTPHeaderFieldsKey, Android
OkHttpDataSource.setDefaultRequestProperties). No requiere código nativo.

── QA ──
- Post 'ready' → reproduce por HLS (en el network inspector: primero
  media.platosmart.com/.../index.m3u8, después
  supabase.platosmart.com/storage/v1/object/sign/media-hls/...).
- Post 'raw' o 'error' → reproduce el MP4 como antes.
- FullscreenVideoViewer reproduce igual que el player del feed.
- Sesión vencida / logout → no crashea; cae al MP4 o muestra el error del player.
- Volver a un video después de 1h de scroll → sigue andando (token nuevo).

Además de usePost.ts y FullscreenVideoViewer, revisá el/los componente(s) que
reproducen stories de video y aplicá la misma lógica ahí.

Decime qué archivos vas a tocar antes de escribir código.
```
