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

- Se buscan archivos `.mp4`, `.webm` y `.m4v` de forma **recursiva**.
- Cada **subcarpeta de primer nivel** se convierte en una fila (categoría). Los vídeos de subcarpetas más profundas heredan la categoría de esa primera carpeta.
- Los vídeos que están directamente en la carpeta raíz aparecen en **Sin categoría**.
- El título es el nombre del archivo sin la extensión.
- Si hay un `poster.jpg` o `folder.jpg` junto a los vídeos, se usa como carátula. También se aceptan `poster.png`, `poster.webp`, `folder.png` y `folder.webp`.
- Si no hay carátula, CasaFlix captura un fotograma del propio vídeo la primera vez que se ve la tarjeta y guarda la miniatura en caché.

### Funciones

- Buscador por título (con o sin tildes).
- Filas horizontales con desplazamiento lateral y flechas.
- Reproductor integrado con controles nativos y botón **Volver**.
- Guardado automático de la posición de reproducción y fila **Continuar viendo**.
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
- `thumbnails/`: miniaturas generadas automáticamente.

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
├── package.json
└── README.md
```

## Verificación durante el desarrollo

El repositorio incluye una prueba de extremo a extremo que abre la aplicación real, comprueba el escaneo, las carátulas, las miniaturas, el buscador, el reproductor, «Continuar viendo» y la pestaña Descubrir, y guarda capturas en `.test-artifacts/`.

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
