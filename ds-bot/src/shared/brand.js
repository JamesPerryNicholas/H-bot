// Original H bot artwork, shared by the desktop icons and in-app avatars.
export const BRAND_COLOR = '#3977F6'
export const BRAND_PATH = 'M410 278H538L478.5 452H587.5L646 278H774L614 746H486L548.5 564H439.5L378 746H250Z'
export const BRAND_EYES = [[490, 508, 20, 28, 0], [536, 508, 20, 28, 0]]

function eyesMask(eyes) {
  return `<mask id="eyes" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="white"/>${eyes ?? '<rect x="480" y="494" width="20" height="28" rx="10" fill="black"/><rect x="526" y="494" width="20" height="28" rx="10" fill="black"/>'}</mask>`
}

function mark(ink) {
  return `<path fill="${ink}" mask="url(#eyes)" d="${BRAND_PATH}"/>`
}

export function iconSvg(plate = 0.88, { eyes, tint } = {}) {
  const inset = 512 * (1 - plate)
  const edge = 1024 * plate
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
${eyesMask(eyes)}
<linearGradient id="enamel" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="${tint ?? '#4B94FF'}"/><stop offset=".45" stop-color="${tint ?? '#2561E8'}"/><stop offset="1" stop-color="${tint ?? '#112F94'}"/></linearGradient>
<radialGradient id="light" cx=".2" cy="0" r="1"><stop stop-color="#A1DBFF" stop-opacity=".6"/><stop offset=".6" stop-color="#74BDFF" stop-opacity="0"/></radialGradient>
<linearGradient id="silver" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="#FFFFFF"/><stop offset=".48" stop-color="#EAF5FF"/><stop offset="1" stop-color="#9CC8F6"/></linearGradient>
<linearGradient id="fold" x1="0" y1="0" x2="1" y2=".8"><stop stop-color="#A2CFFF"/><stop offset=".45" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C0DDFF"/></linearGradient>
<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#E4F5FF" stop-opacity=".65"/><stop offset=".5" stop-color="#ACD5FF" stop-opacity=".12"/><stop offset="1" stop-color="#040F50" stop-opacity=".6"/></linearGradient>
<filter id="shadow" x="-.3" y="-.3" width="1.6" height="1.7" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="16"/></filter>
</defs>
<rect x="${inset}" y="${inset}" width="${edge}" height="${edge}" rx="${edge * 0.245}" fill="url(#enamel)"/>
<rect x="${inset}" y="${inset}" width="${edge}" height="${edge}" rx="${edge * 0.245}" fill="url(#light)"/>
<rect x="${inset + 2}" y="${inset + 2}" width="${edge - 4}" height="${edge - 4}" rx="${edge * 0.245 - 2}" fill="none" stroke="url(#rim)" stroke-width="4"/>
<g transform="translate(0 20)" opacity=".32" filter="url(#shadow)">${mark('#061A60')}</g>
${mark('url(#silver)')}
<path d="M478.5 452H587.5L548.5 564H439.5Z" fill="url(#fold)" mask="url(#eyes)"/>
<path d="M410 278H538M646 278H774M478.5 452H587.5" fill="none" stroke="#FFFFFF" stroke-opacity=".85" stroke-width="3"/>
</svg>\n`
}

export function traySvg(ink) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="198 198 628 628"><defs>${eyesMask()}</defs>${mark(ink)}</svg>\n`
}

