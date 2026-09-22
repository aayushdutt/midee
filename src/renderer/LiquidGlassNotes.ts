import {
  Container,
  GlProgram,
  GpuProgram,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  UniformGroup,
} from 'pixi.js'
import type { NoteMaterial } from './NoteMaterial'

// Clear water lenses, lit by the same optical plate used behind the roll.
// This is environment-map refraction, not a capture of the stage: labels,
// adjacent notes and particles are deliberately not included in the sampler.
interface LiquidNote {
  mesh: Mesh<MeshGeometry, Shader>
  shader: Shader
  uniforms: UniformGroup<{
    uSize: { value: Float32Array; type: 'vec2<f32>' }
    uOrigin: { value: Float32Array; type: 'vec2<f32>' }
    uViewport: { value: Float32Array; type: 'vec2<f32>' }
    uTint: { value: Float32Array; type: 'vec3<f32>' }
    uTime: { value: number; type: 'f32' }
    uSeed: { value: number; type: 'f32' }
    uStrike: { value: number; type: 'f32' }
  }>
}

export class LiquidGlassNotes implements NoteMaterial {
  readonly container = new Container({ label: 'liquid-glass-notes' })
  // Scheduled, live and loop renderers each own a material. Empty streams
  // need no optical canvas, geometry or shader-program reflection metadata.
  private resources: {
    environment: Texture
    geometry: MeshGeometry
    glProgram: GlProgram
    gpuProgram: GpuProgram
  } | null = null
  private readonly viewport = new Float32Array([1280, 720])
  private pool: LiquidNote[] = []
  private used = 0
  private visibleCount = 0

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
    color: number,
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
        uTint: { value: new Float32Array(3), type: 'vec3<f32>' },
        uTime: { value: 0, type: 'f32' },
        uSeed: { value: 0, type: 'f32' },
        uStrike: { value: 0, type: 'f32' },
      })
      const shader = new Shader({
        glProgram: resources.glProgram,
        gpuProgram: resources.gpuProgram,
        resources: {
          liquidUniforms: uniforms,
          uEnvironment: resources.environment.source,
          uEnvironmentSampler: resources.environment.source.style,
        },
      })
      const mesh = new Mesh({ geometry: resources.geometry, shader })
      this.container.addChild(mesh)
      note = { mesh, shader, uniforms }
      this.pool.push(note)
    }
    note.mesh.position.set(x, y)
    note.mesh.scale.set(width, height)
    note.mesh.alpha = alpha
    note.mesh.visible = true
    const u = note.uniforms.uniforms
    u.uSize[0] = width
    u.uSize[1] = height
    u.uOrigin[0] = x
    u.uOrigin[1] = y
    u.uTint[0] = ((color >> 16) & 255) / 255
    u.uTint[1] = ((color >> 8) & 255) / 255
    u.uTint[2] = (color & 255) / 255
    u.uTime = time
    u.uSeed = (seed % 997) * 0.731
    u.uStrike = active ? 0.12 + Math.exp(-Math.max(0, time - onset) * 5) * 0.88 : 0
    note.uniforms.update()
  }

  end(): void {
    for (let i = this.used; i < this.visibleCount; i++) this.pool[i]!.mesh.visible = false
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
      this.resources.environment.destroy(true)
      this.resources.glProgram.destroy()
      this.resources.gpuProgram.destroy()
      this.resources = null
    }
  }

  private getResources(): NonNullable<LiquidGlassNotes['resources']> {
    if (!this.resources) {
      this.resources = {
        environment: createLiquidEnvironmentTexture(),
        geometry: new MeshGeometry({}),
        glProgram: new GlProgram({
          name: 'liquid-glass',
          vertex: vertexGl,
          fragment: fragmentGl,
        }),
        gpuProgram: new GpuProgram({
          name: 'liquid-glass',
          vertex: { source: vertexGpu, entryPoint: 'main' },
          fragment: { source: fragmentGpu, entryPoint: 'main' },
        }),
      }
    }
    return this.resources
  }
}

// One authored, repeatable optical environment. Broad light windows give a
// clear lens something to bend; there is intentionally no grain or opacity
// baked into the lens itself. Generate only on material/theme construction.
export function createLiquidEnvironmentTexture(): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 512
  const ctx = canvas.getContext('2d')!
  const wash = ctx.createLinearGradient(0, 0, 0, 512)
  wash.addColorStop(0, '#040d13')
  wash.addColorStop(0.6, '#07151d')
  wash.addColorStop(1, '#10242c')
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, 512, 512)
  // Quiet reflections over a dark pool: restrained contrast leaves the crisp
  // glass meniscus prominent while retaining a little structure to refract.
  ctx.save()
  ctx.translate(256, 256)
  ctx.rotate(-0.36)
  for (const [x, width, opacity] of [
    [-180, 72, 0.034],
    [-35, 20, 0.022],
    [102, 96, 0.025],
  ]) {
    const light = ctx.createLinearGradient(x!, 0, x! + width!, 0)
    light.addColorStop(0, 'rgba(178,227,227,0)')
    light.addColorStop(0.38, `rgba(178,227,227,${opacity})`)
    light.addColorStop(0.51, `rgba(213,240,236,${opacity! * 1.5})`)
    light.addColorStop(0.68, `rgba(178,227,227,${opacity! * 0.6})`)
    light.addColorStop(1, 'rgba(178,227,227,0)')
    ctx.fillStyle = light
    ctx.fillRect(x!, -450, width!, 900)
  }
  ctx.restore()
  const light = ctx.createRadialGradient(290, 470, 10, 290, 420, 300)
  light.addColorStop(0, 'rgba(141,217,209,0.034)')
  light.addColorStop(1, 'rgba(141,217,209,0)')
  ctx.fillStyle = light
  ctx.fillRect(0, 0, 512, 512)
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

// The mathematical body is shared by GLSL and WGSL generation so changes in
// the lens cannot silently diverge across render backends. The tiny builder
// emits typed declarations only; all expressions below are valid in both.
function lensBody(gpu: boolean): string {
  const v2 = gpu ? 'vec2<f32>' : 'vec2'
  const v3 = gpu ? 'vec3<f32>' : 'vec3'
  const v4 = gpu ? 'vec4<f32>' : 'vec4'
  const uniform = (name: string) => (gpu ? `liquidUniforms.${name}` : name)
  const decl = (type: string, name: string, expr: string) =>
    gpu
      ? `let ${name}: ${type === 'float' ? 'f32' : type} = ${expr};`
      : `${type} ${name} = ${expr};`
  const u = uniform
  const sample = (uv: string) =>
    gpu
      ? `textureSample(uEnvironment, uEnvironmentSampler, ${uv}).rgb`
      : `texture(uEnvironment, ${uv}).rgb`
  return [
    decl(v2, 'size', `${u('uSize')}`),
    decl('float', 't', `${u('uTime')} * 0.68 + ${u('uSeed')}`),
    decl(v2, 'pixel', `vUV * size`),
    // Surface tension keeps both caps quiet. The sides breathe by fractions
    // of a pixel, always inside the allocated key width.
    decl('float', 'capFade', 'sin(vUV.y * 3.14159265)'),
    decl(
      'float',
      'flow',
      'sin(pixel.y * 0.024 - t) * 0.62 + sin(pixel.y * 0.047 + t * 0.71) * 0.25',
    ),
    decl('float', 'wave', 'flow * capFade * min(size.x * 0.026, 0.58)'),
    decl(v2, 'p', `pixel - size * 0.5 + ${v2}(wave, 0.0)`),
    decl('float', 'radius', 'min(7.5, min(size.x * 0.31, size.y * 0.48))'),
    decl(v2, 'q', `abs(p) - (size * 0.5 - ${v2}(radius + 0.7))`),
    decl('float', 'distance', `length(max(q, ${v2}(0.0))) + min(max(q.x, q.y), 0.0) - radius`),
    decl('float', 'coverage', '1.0 - smoothstep(-0.65, 0.65, distance)'),
    decl('float', 'inset', 'max(0.0, -distance)'),
    decl('float', 'rim', 'exp(-inset * 1.4)'),
    decl('float', 'meniscus', 'exp(-pow((inset - 2.0) / 1.2, 2.0))'),
    decl('float', 'cross', 'p.x / max(size.x * 0.5, 1.0)'),
    decl('float', 'tip', 'exp(-min(pixel.y, size.y - pixel.y) / max(radius, 1.0))'),
    decl(
      v2,
      'normal',
      `${v2}(cross * (0.6 + pow(abs(cross), 4.0) * 1.8) + flow * 0.25, sin(pixel.y * 0.027 - t) * 0.4 + sign(p.y) * tip)`,
    ),
    decl(v2, 'world', `${u('uOrigin')} + pixel`),
    decl(v2, 'environmentUV', `world / ${u('uViewport')}`),
    // Large studio lights move together across the optical environment. The
    // reflected coordinate bends with each lens normal; a descending note
    // crosses the light instead of carrying a painted stripe with it.
    decl('float', 'studioTime', `${u('uTime')} * 0.34`),
    decl('float', 'studioY', `${u('uViewport')}.y * (0.39 + sin(studioTime) * 0.20)`),
    decl(
      'float',
      'studioCoord',
      'world.y - studioY + normal.x * 44.0 + sin(world.x * 0.003 + studioTime * 0.3) * 29.0',
    ),
    decl('float', 'studioWide', 'exp(-pow(studioCoord / 68.0, 2.0))'),
    decl('float', 'studioStrip', 'exp(-pow((studioCoord + 12.0) / 8.5, 2.0))'),
    decl(
      'float',
      'secondWindow',
      `exp(-pow((world.y - ${u('uViewport')}.y * 0.83 + cos(studioTime * 0.8) * 38.0 - normal.x * 30.0) / 34.0, 2.0))`,
    ),
    decl(
      v2,
      'bend',
      `(normal * ${v2}(26.0, 17.0) + ${v2}(flow * 4.0, cos(t + pixel.y * 0.019) * 5.0)) / ${u('uViewport')}`,
    ),
    decl(v2, 'sampleUV', `clamp(environmentUV + bend, ${v2}(0.002), ${v2}(0.998))`),
    decl(v2, 'dispersion', `normal * 0.6 / ${u('uViewport')}`),
    decl(v3, 'sampleA', sample('sampleUV + dispersion')),
    decl(v3, 'sampleB', sample('sampleUV')),
    decl(v3, 'sampleC', sample('sampleUV - dispersion')),
    decl(v3, 'refracted', `${v3}(sampleA.r, sampleB.g, sampleC.b)`),
    // Highlights are reflections from broad light sources, with one precise
    // curved hairline. There are no etched stripes or particulate inclusions.
    decl(
      'float',
      'ribbonX',
      '0.23 + sin(pixel.y * 0.019 - t * 0.7) * 0.105 + sin(pixel.y * 0.007 + t) * 0.055',
    ),
    decl('float', 'ribbon', 'exp(-pow((vUV.x - ribbonX) / 0.1, 2.0))'),
    decl(
      'float',
      'hairline',
      'exp(-pow((vUV.x - ribbonX + 0.068) * max(size.x, 5.0) / 0.55, 2.0))',
    ),
    decl(
      'float',
      'backline',
      'exp(-pow((vUV.x - 0.78 - flow * 0.04) * max(size.x, 5.0) / 1.0, 2.0))',
    ),
    decl('float', 'window', '0.55 + sin(pixel.y * 0.012 + t * 0.4) * 0.3'),
    decl('float', 'bottom', 'exp(-(size.y - pixel.y) / 4.0)'),
    decl('float', 'lobe', 'exp(-pow((vUV.y - 0.5 - sin(t * 0.41) * 0.32) / 0.17, 2.0))'),
    // A curved caustic is confined to the light window, rather than becoming
    // a persistent decorative line. Two sides of the lens focus it differently.
    decl('float', 'causticX', '0.57 + sin(pixel.y * 0.032 - t * 0.65) * 0.17'),
    decl(
      'float',
      'caustic',
      'exp(-pow((vUV.x - causticX) * max(size.x, 5.0) / 1.3, 2.0)) * studioWide',
    ),
    // A polished cap catches a small moving window, while the far edge
    // flashes only as it crosses the studio strip. Both accents stay in the
    // meniscus: the transparent interior and the dark environment are intact.
    decl(
      'float',
      'capReflection',
      'exp(-pow((cross - sin(studioTime * 0.63 + world.x * 0.006) * 0.35) / 0.68, 2.0))',
    ),
    decl('float', 'capPolish', 'rim * tip * (0.24 + capReflection * 0.62)'),
    decl('float', 'edgeAccent', 'rim * max(0.0, cross) * studioStrip * 0.48'),
    decl('float', 'strikeDistance', `max(0.0, ${u('uViewport')}.y - world.y)`),
    decl('float', 'strikeLight', `${u('uStrike')} * exp(-strikeDistance / 24.0)`),
    decl('float', 'strikeLip', `${u('uStrike')} * exp(-strikeDistance / 2.2)`),
    decl(
      'float',
      'specular',
      `rim * (0.32 + 0.48 * max(0.0, -cross) + studioWide * 0.58 + secondWindow * 0.30) + hairline * window * (0.60 + lobe * 0.5 + studioWide * 1.45) + ribbon * (window * 0.16 + studioWide * 0.32) + backline * (0.12 + secondWindow * 0.58) + studioStrip * (0.10 + ribbon * 0.42) + caustic * 0.35 + bottom * 0.18 + capPolish + edgeAccent + strikeLight * (0.08 + rim * 0.8) + strikeLip * (0.22 + 0.18 * (1.0 - abs(cross)))`,
    ),
    decl(v3, 'silver', `mix(${v3}(0.88, 0.98, 0.97), ${u('uTint')}, 0.13)`),
    decl(v3, 'optical', 'refracted * (1.04 + meniscus * 0.9) * (1.0 - meniscus * 0.2)'),
    decl(
      'float',
      'opacity',
      'clamp(0.31 + rim * 0.42 + specular * 0.34 + meniscus * 0.10, 0.0, 0.94) * coverage',
    ),
    decl(v3, 'surface', 'optical + silver * specular * 0.88'),
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
uniform vec3 uTint;
uniform float uTime;
uniform float uSeed;
uniform float uStrike;
uniform sampler2D uEnvironment;
void main() { ${lensBody(false)} }
`

const fragmentGpu = `
struct LiquidUniforms {
  uSize: vec2<f32>,
  uOrigin: vec2<f32>,
  uViewport: vec2<f32>,
  uTint: vec3<f32>,
  uTime: f32,
  uSeed: f32,
  uStrike: f32,
}
@group(2) @binding(0) var<uniform> liquidUniforms: LiquidUniforms;
@group(2) @binding(1) var uEnvironment: texture_2d<f32>;
@group(2) @binding(2) var uEnvironmentSampler: sampler;
@fragment fn main(@location(0) vUV: vec2<f32>, @location(1) vColor: vec4<f32>) -> @location(0) vec4<f32> {
  ${lensBody(true)}
}
`
