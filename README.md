# CasaFlix

Biblioteca de vídeo local para escritorio con una interfaz sencilla inspirada en las plataformas de streaming. Está construida con **Electron, HTML, CSS y JavaScript**, sin frameworks ni servicios externos.

Todo el contenido de tu biblioteca se queda en tu equipo: CasaFlix no sube archivos ni envía datos a ningún servidor.

## Requisitos

- Node.js 20 o superior
- npm 9 o superior
- Windows, macOS o Linux

## Instalación y uso

```bash
npm install
npm start
```

En la primera ejecución, pulsa **Elegir carpeta de vídeos** y selecciona la carpeta donde guardas tus películas o series. La aplicación recordará esa ruta.

### Cómo se organiza la biblioteca

CasaFlix trabaja con dos apartados fijos: **Películas** y **Series**.

- Dentro de la carpeta elegida debe haber dos subcarpetas: `Peliculas` y `Series`. Se aceptan mayúsculas, minúsculas y la variante `Películas` con tilde.
- Si alguna no existe, CasaFlix la crea vacía y muestra un aviso recordando la estructura. El aviso se puede cerrar.
- Se buscan archivos `.mp4`, `.webm` y `.m4v`.

**Películas**

- Cada vídeo dentro de `Peliculas` (también en sus subcarpetas) es una película.
- La cuadrícula muestra la carátula, el título y la duración.

**Series**

- Cada subcarpeta directa de `Series` es una serie. Las subcarpetas vacías no aparecen.
- La carátula de la serie es `poster.jpg` o `folder.jpg` dentro de su carpeta (también se aceptan `.jpeg`, `.png` y `.webp`). Si no hay, se usa la miniatura del primer episodio.
- Al pulsar una serie se abre su vista de detalle con las temporadas y los episodios.
- Las subcarpetas de la serie se tratan como temporadas. Los episodios se ordenan de forma natural: `Episodio 2` antes que `Episodio 10`.
- Si no hay subcarpetas de temporada, todos los episodios forman **Temporada 1**. Si hay temporadas y además episodios sueltos en la carpeta de la serie, estos aparecen en **Sin temporada**.
- El título de cada episodio es el nombre del archivo sin la extensión y sin el prefijo de número (`Episodio 2 - La tormenta` se muestra como «La tormenta»).

Ejemplo de estructura:

```text
Mi carpeta/
├── Peliculas/
│   ├── Atardecer en la costa.mp4
│   └── Atardecer en la costa.jpg
└── Series/
    └── La casa del faro/
        ├── poster.jpg
        ├── Temporada 1/
        │   ├── Episodio 1 - La llegada.mp4
        │   └── Episodio 2 - La tormenta.mp4
        └── Temporada 2/
            └── Episodio 1 - Nuevo horizonte.mp4
```

**Carátulas y duraciones**

- Si un vídeo tiene una imagen con su mismo nombre (por ejemplo `Atardecer en la costa.jpg`) se usa como carátula propia.
- Si no hay carátula, CasaFlix captura un fotograma del propio vídeo la primera vez que se ve la tarjeta y guarda la miniatura en caché.
- La duración se lee del archivo de forma perezosa y se guarda en caché para no repetir el proceso.

### Funciones

- Pestañas **Películas**, **Series** y **Descubrir**, con buscador, botón de carpeta y actualización.
- Buscador por título (con o sin tildes); en Series también busca en los títulos de los episodios.
- Cuadrícula de películas, cuadrícula de series y vista de detalle con temporadas y episodios.
- Reproductor integrado con controles nativos y botón **Volver**.
- Guardado automático de la posición de reproducción y fila **Continuar viendo** en cada apartado: películas en Películas y el último episodio de cada serie en Series.
- Botón **Siguiente episodio** en el reproductor, que se destaca al terminar un episodio.
- Pestaña **Descubrir** con enlaces a servicios gratuitos y legales. Los enlaces se abren en el navegador del sistema.
- Aviso en **Descubrir** cuando no hay conexión. La biblioteca local sigue funcionando sin internet.

## Personalizar la pestaña Descubrir

Edita el archivo [`links.json`](./links.json) con cualquier editor de texto:

```json
{
  "links": [
    {
      "id": "mi-enlace",
      "name": "Mi servicio",
      "url": "https://ejemplo.com/catalogo",
      "description": "Descripción breve opcional."
    }
  ]
}
```

Vuelve a la pestaña **Descubrir** para recargar la lista. Solo se aceptan URLs `http://` y `https://`; los enlaces se abren con el navegador predeterminado, nunca dentro de la aplicación.

## Dónde se guardan los datos

CasaFlix usa la carpeta de datos de usuario de Electron:

| Sistema | Ruta habitual |
| --- | --- |
| Windows | `%APPDATA%\CasaFlix` |
| macOS | `~/Library/Application Support/CasaFlix` |
| Linux | `~/.config/CasaFlix` |

Allí se guardan:

- `config.json`: ruta de la carpeta de vídeos elegida.
- `progress.json`: posición de reproducción de cada vídeo.
- `durations.json`: duraciones ya leídas de los vídeos.
- `thumbnails/`: miniaturas generadas automáticamente.

El progreso se asocia a la ruta de cada archivo, no a la categoría, así que se conserva aunque reorganices la biblioteca o cambies el nombre de una serie.

Para una instalación portable o para pruebas se puede indicar otra carpeta de datos con la variable de entorno `CASAFLIX_USER_DATA`:

```bash
# PowerShell
$env:CASAFLIX_USER_DATA="$PWD\.datos"; npm start
```

## Empaquetar la aplicación

El proyecto incluye `electron-builder` como dependencia de desarrollo.

```bash
# Instalador NSIS + versión portable para Windows
npm run dist:win

# Según el sistema operativo actual
npm run dist

# Carpeta desempaquetada, útil para comprobar el resultado sin instalador
npm run dist:dir
```

Los artefactos se generan en `release/`.

Notas sobre el empaquetado:

- La primera vez, `electron-builder` puede descargar binarios adicionales; necesita conexión.
- No se ha configurado firma de código. Windows SmartScreen o macOS Gatekeeper pueden mostrar un aviso al abrir una compilación propia.
- La aplicación busca `links.json` dentro de sus recursos. Para cambiar los enlaces después de empaquetar, hay que volver a generar la aplicación con el archivo actualizado.

## Estructura del proyecto

```text
mi-netflix/
├── main.js            # Proceso principal: ventana, escaneo, IPC, protocolo local
├── preload.js          # Puente seguro con contextBridge
├── renderer/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── links.json          # Enlaces editables de Descubrir
├── LICENSE             # Licencia MIT
├── package.json
└── README.md
```

## Verificación durante el desarrollo

El repositorio incluye una prueba de extremo a extremo que abre la aplicación real y comprueba la creación de `Peliculas` y `Series`, las cuadrículas de películas y series, las carátulas, las miniaturas, las duraciones, el buscador, la vista de detalle, el orden natural de los episodios, el reproductor, «Continuar viendo» en cada apartado, el botón de siguiente episodio y la pestaña Descubrir. Las capturas se guardan en `.test-artifacts/`.

```bash
# 1. Genera vídeos de prueba originales con MediaRecorder
npm run test:media

# 2. Ejecuta la verificación (Electron + CDP, sin dependencias extra)
npm run test:e2e
```

Los vídeos y las capturas de prueba están ignorados por git.

## Seguridad y privacidad

- `contextIsolation` activado, `nodeIntegration` desactivado y `sandbox` activado.
- El renderer no tiene acceso a Node.js ni al sistema de archivos; solo usa una API mínima expuesta por `preload.js`.
- Los vídeos y las carátulas se sirven mediante un protocolo local propio, no mediante `file://`.
- El contenido de la biblioteca se lee en local y nunca se envía por la red.
- Los enlaces externos solo se abren si están listados en `links.json` y usan `http` o `https`.

## Limitaciones

- La reproducción depende de los códecs que incluya Electron/Chromium. Los MP4 con H.264 y AAC son la opción más compatible; algunos códecs o archivos dañados pueden no reproducirse.
- La detección de conexión usa el estado de red del sistema. En redes cautivas puede indicar «en línea» aunque el acceso a internet sea limitado.
- CasaFlix es un proyecto original y no está afiliado a ninguno de los servicios enlazados en **Descubrir**. Las marcas y los contenidos de terceros pertenecen a sus respectivos titulares.

## Licencia

Este proyecto se distribuye bajo la licencia MIT. Copyright © 2026 **Agli333**. Consulta el archivo [`LICENSE`](./LICENSE).
