import {
  Container,
  GlProgram,
  GpuProgram,
  Mesh,
  MeshGeometry,
  Shader,
  Sprite,
  Texture,
  UniformGroup,
} from 'pixi.js'
import type { NoteMaterial } from '../NoteMaterial'

interface EmberNote {
  mesh: Mesh<MeshGeometry, Shader>
  light: Sprite
  contact: Sprite
  shader: Shader
  uniforms: UniformGroup<{
    uSize: { value: Float32Array; type: 'vec2<f32>' }
    uOrigin: { value: Float32Array; type: 'vec2<f32>' }
    uViewport: { value: Float32Array; type: 'vec2<f32>' }
    uTime: { value: number; type: 'f32' }
    uSeed: { value: number; type: 'f32' }
    uStrike: { value: number; type: 'f32' }
  }>
}

/** Violet resin warms through rose into honey as it approaches the keyboard.
 * The colour field belongs to the viewport; etched grain belongs to the full
 * note. Consuming a note therefore neither squashes texture nor freezes light.
 * All motion samples song time. No simulation, per-frame canvas or filters.
 */
export class EmberMistNotes implements NoteMaterial {
  readonly container = new Container({ label: 'ember-mist-notes' })
  private readonly lights = new Container()
  private readonly bodies = new Container()
  private readonly viewport = new Float32Array([1280, 720])
  private readonly pool: EmberNote[] = []
  private used = 0
  private visibleCount = 0
  private resources: {
    geometry: MeshGeometry
    glProgram: GlProgram
    gpuProgram: GpuProgram
    light: Texture
  } | null = null

  constructor() {
    this.container.addChild(this.lights, this.bodies)
  }

  setViewport(width: number, height: number): void {
    this.viewport[0] = Math.max(1, width)
    this.viewport[1] = Math.max(1, height)
  }

  begin(): void {
    this.used = 0
    this.container.visible = true
  }

  place(
    x: number,
    y: number,
    width: number,
    height: number,
    _color: number,
    alpha: number,
    time: number,
    onset: number,
    seed: number,
    active: boolean,
  ): void {
    if (width <= 0 || height <= 0 || alpha <= 0) return
    let note = this.pool[this.used++]
    if (!note) {
      const resources = this.getResources()
      const uniforms = new UniformGroup({
        uSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uViewport: { value: this.viewport, type: 'vec2<f32>' },
        uTime: { value: 0, type: 'f32' },
        uSeed: { value: 0, type: 'f32' },
        uStrike: { value: 0, type: 'f32' },
      })
      const shader = new Shader({
        glProgram: resources.glProgram,
        gpuProgram: resources.gpuProgram,
        resources: { emberUniforms: uniforms },
      })
      const mesh = new Mesh({ geometry: resources.geometry, shader })
      const light = new Sprite(resources.light)
      const contact = new Sprite(resources.light)
      light.anchor.set(0.5)
      contact.anchor.set(0.5)
      light.blendMode = contact.blendMode = 'add'
      light.tint = 0xde9960
      contact.tint = 0xffd49a
      this.lights.addChild(light, contact)
      this.bodies.addChild(mesh)
      note = { mesh, light, contact, shader, uniforms }
      this.pool.push(note)
    }
    note.mesh.position.set(x, y)
    note.mesh.scale.set(width, height)
    note.mesh.alpha = alpha
    note.mesh.visible = true
    const impulse = active ? Math.exp(-Math.max(0, time - onset) * 5.5) : 0
    const u = note.uniforms.uniforms
    u.uSize[0] = width
    u.uSize[1] = height
    u.uOrigin[0] = x
    u.uOrigin[1] = y
    u.uTime = time
    u.uSeed = (seed % 997) * 0.731
    u.uStrike = active ? 0.16 + impulse * 0.64 : 0
    note.uniforms.update()
    note.light.visible = note.contact.visible = active
    if (active) {
      const strikeY = Math.min(y + height, this.viewport[1]!)
      note.light.position.set(x + width * 0.5, strikeY - 5)
      note.light.width = width * 2.5 + 12
      note.light.height = 42 + impulse * 20
      note.light.alpha = alpha * (0.11 + impulse * 0.08)
      note.contact.position.set(x + width * 0.5, strikeY - 1)
      note.contact.width = width * (1.5 + impulse * 0.55)
      note.contact.height = 5 + impulse * 5
      note.contact.alpha = alpha * (0.3 + impulse * 0.3)
    }
  }

  end(): void {
    for (let i = this.used; i < this.visibleCount; i++) {
      const note = this.pool[i]!
      note.mesh.visible = note.light.visible = note.contact.visible = false
    }
    this.visibleCount = this.used
  }

  clear(): void {
    this.used = 0
    this.end()
    this.container.visible = false
  }

  destroy(): void {
    this.container.destroy({ children: true })
    for (const note of this.pool) note.shader.destroy()
    this.pool.length = 0
    if (this.resources) {
      this.resources.geometry.destroy()
      this.resources.light.destroy(true)
      this.resources.glProgram.destroy()
      this.resources.gpuProgram.destroy()
      this.resources = null
    }
  }

  private getResources(): NonNullable<EmberMistNotes['resources']> {
    if (!this.resources) {
      this.resources = {
        geometry: new MeshGeometry({}),
        glProgram: new GlProgram({ name: 'ember-mist', vertex: vertexGl, fragment: fragmentGl }),
        gpuProgram: new GpuProgram({
          name: 'ember-mist',
          vertex: { source: vertexGpu, entryPoint: 'main' },
          fragment: { source: fragmentGpu, entryPoint: 'main' },
        }),
        light: makeContactLight(),
      }
    }
    return this.resources
  }
}

function makeContactLight(): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 96
  const ctx = canvas.getContext('2d')!
  const glow = ctx.createRadialGradient(48, 48, 0, 48, 48, 48)
  glow.addColorStop(0, 'rgba(255,255,255,0.9)')
  glow.addColorStop(0.2, 'rgba(255,255,255,0.32)')
  glow.addColorStop(0.58, 'rgba(255,255,255,0.045)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, 96, 96)
  return Texture.from(canvas)
}

const vertexGl = `
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec4 uColor;
out vec2 vUV;
out vec4 vColor;
void main() {
  vUV = aUV;
  vColor = uColor * uWorldColorAlpha;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`

const vertexGpu = `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
}
@vertex fn main(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>((globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
  out.vUV = aUV;
  out.vColor = localUniforms.uColor * globalUniforms.uWorldColorAlpha;
  return out;
}`

// One expression body emits both backends. Fixed pixel-scale grain has no
// height normalization, and all gradient/strike coordinates use world space.
function emberBody(gpu: boolean): string {
  const v2 = gpu ? 'vec2<f32>' : 'vec2'
  const v3 = gpu ? 'vec3<f32>' : 'vec3'
  const v4 = gpu ? 'vec4<f32>' : 'vec4'
  const u = (name: string) => (gpu ? `emberUniforms.${name}` : name)
  const decl = (type: string, name: string, expr: string) =>
    gpu
      ? `let ${name}: ${type === 'float' ? 'f32' : type} = ${expr};`
      : `${type} ${name} = ${expr};`
  return [
    decl(v2, 'size', u('uSize')),
    decl(v2, 'pixel', 'vUV * size'),
    decl(v2, 'world', `${u('uOrigin')} + pixel`),
    decl('float', 't', `${u('uTime')} * 0.46 + ${u('uSeed')}`),
    decl('float', 'radius', 'min(4.5, min(size.x * 0.22, size.y * 0.48))'),
    decl(v2, 'p', 'pixel - size * 0.5'),
    decl(v2, 'q', `abs(p) - (size * 0.5 - ${v2}(radius + 0.55))`),
    decl('float', 'distance', `length(max(q, ${v2}(0.0))) + min(max(q.x, q.y), 0.0) - radius`),
    decl('float', 'coverage', '1.0 - smoothstep(-0.65, 0.65, distance)'),
    decl('float', 'inset', 'max(0.0, -distance)'),
    decl('float', 'edge', 'exp(-inset * 1.65)'),
    decl('float', 'worldHeight', `clamp(world.y / ${u('uViewport')}.y, 0.0, 1.0)`),
    decl(v3, 'violet', `${v3}(0.54, 0.27, 0.68)`),
    decl(v3, 'rose', `${v3}(0.82, 0.45, 0.53)`),
    decl(v3, 'honey', `${v3}(1.0, 0.76, 0.40)`),
    decl(v3, 'upper', 'mix(violet, rose, smoothstep(0.14, 0.69, worldHeight))'),
    decl(v3, 'palette', 'mix(upper, honey, smoothstep(0.62, 0.98, worldHeight))'),
    // Shallow internal currents refract through the warm resin. Slow motion
    // changes their light, while the finer engraved striae remain attached.
    decl(
      'float',
      'flow',
      `sin(pixel.y * 0.019 + ${u('uSeed')}) * 2.3 + sin(pixel.y * 0.007 - ${u('uSeed')} * 0.3) * 1.5`,
    ),
    decl('float', 'fiberX', 'pixel.x + flow + sin(pixel.x * 0.14 + pixel.y * 0.009) * 0.65'),
    decl(
      'float',
      'etch',
      'sin(fiberX * 4.3 + sin(pixel.y * 0.044) * 0.9) * 0.017 + sin(fiberX * 2.1 - pixel.y * 0.11) * 0.012',
    ),
    decl('float', 'broadGrain', 'sin(fiberX * 0.39 + sin(pixel.y * 0.025) * 0.8) * 0.06'),
    decl(
      'float',
      'dust',
      `fract(sin(dot(floor(pixel * 1.6), ${v2}(12.9898, 78.233)) + ${u('uSeed')}) * 43758.5453) - 0.5`,
    ),
    decl('float', 'channel', 'exp(-pow((vUV.x - 0.68 + flow * 0.009) / 0.22, 2.0))'),
    decl('float', 'bevel', 'smoothstep(0.0, 3.2, inset)'),
    // Subsurface warmth intensifies on approach without bleaching the violet above.
    decl('float', 'heat', 'smoothstep(0.64, 1.0, worldHeight)'),
    decl(
      'float',
      'depth',
      '0.83 - channel * 0.17 + broadGrain + etch + dust * 0.035 + heat * 0.27',
    ),
    decl('float', 'reflectionX', '0.22 + sin(pixel.y * 0.015 - t * 0.6) * 0.07'),
    decl('float', 'reflection', 'exp(-pow((vUV.x - reflectionX) * max(size.x, 4.0) / 0.85, 2.0))'),
    decl('float', 'shoulder', 'exp(-pow((vUV.x - reflectionX - 0.02) / 0.13, 2.0))'),
    decl(
      'float',
      'studio',
      `exp(-pow((world.y - ${u('uViewport')}.y * (0.43 + sin(${u('uTime')} * 0.29) * 0.19) + p.x * 1.6) / 56.0, 2.0))`,
    ),
    decl(
      'float',
      'reflectionLight',
      'reflection * (0.12 + studio * 0.48) + shoulder * (0.04 + studio * 0.11)',
    ),
    decl('float', 'cap', 'exp(-min(pixel.y, size.y - pixel.y) / 2.3)'),
    decl('float', 'rimLight', 'edge * (0.13 + 0.19 * (1.0 - vUV.x)) + cap * 0.08'),
    decl(
      'float',
      'strikeDistance',
      `max(0.0, min(${u('uOrigin')}.y + size.y, ${u('uViewport')}.y) - world.y)`,
    ),
    decl('float', 'strike', `${u('uStrike')} * exp(-strikeDistance / 20.0)`),
    decl(
      v3,
      'reflectionTint',
      `mix(${v3}(0.83, 0.72, 0.94), ${v3}(1.0, 0.90, 0.67), smoothstep(0.45, 0.96, worldHeight))`,
    ),
    decl(
      v3,
      'surface',
      `palette * depth * (0.83 + bevel * 0.17) + reflectionTint * (reflectionLight + rimLight) + ${v3}(1.0, 0.64, 0.27) * strike * (0.12 + edge * 0.19)`,
    ),
    decl(
      'float',
      'opacity',
      'coverage * clamp(0.79 + edge * 0.11 + reflectionLight * 0.10, 0.0, 0.96)',
    ),
    gpu
      ? `return ${v4}(surface * opacity, opacity) * vColor;`
      : `finalColor = ${v4}(surface * opacity, opacity) * vColor;`,
  ].join('\n')
}

const fragmentGl = `
in vec2 vUV;
in vec4 vColor;
out vec4 finalColor;
uniform vec2 uSize;
uniform vec2 uOrigin;
uniform vec2 uViewport;
uniform float uTime;
uniform float uSeed;
uniform float uStrike;
void main() { ${emberBody(false)} }
`

const fragmentGpu = `
struct EmberUniforms {
  uSize: vec2<f32>,
  uOrigin: vec2<f32>,
  uViewport: vec2<f32>,
  uTime: f32,
  uSeed: f32,
  uStrike: f32,
}
@group(2) @binding(0) var<uniform> emberUniforms: EmberUniforms;
@fragment fn main(@location(0) vUV: vec2<f32>, @location(1) vColor: vec4<f32>) -> @location(0) vec4<f32> {
  ${emberBody(true)}
}
`
