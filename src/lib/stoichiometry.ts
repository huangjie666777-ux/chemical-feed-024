import { Fraction } from './fraction'

export type AmountUnit = 'mol' | 'mmol' | 'g'

export interface SpeciesDosingInput {
  amountText: string
  unit: AmountUnit
  /** 摩尔质量，单位 g/mol；空串表示未填写 */
  molarMassText: string
}

export function emptyDosingInput(): SpeciesDosingInput {
  return { amountText: '', unit: 'mol', molarMassText: '' }
}

export type DecimalParse = { ok: true; value: Fraction } | { ok: false; message: string }

/** 解析普通十进制数（不支持科学计数法），空值、负数、非法文本都报错。 */
export function parseDecimal(text: string, opts: { allowZero: boolean }): DecimalParse {
  const t = text.trim()
  if (t === '') return { ok: false, message: '不能为空，请填写数值' }
  if (t.startsWith('-') || t.startsWith('−') || t.startsWith('–')) {
    return { ok: false, message: '不能为负数' }
  }
  if (!/^\d+(\.\d+)?$/.test(t) && !/^\.\d+$/.test(t)) {
    return { ok: false, message: '不是合法的十进制数（支持如 2、0.5、1.25）' }
  }
  const dot = t.indexOf('.')
  const intPart = dot === -1 ? t : t.slice(0, dot)
  const fracPart = dot === -1 ? '' : t.slice(dot + 1)
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '') || '0'
  const value = new Fraction(BigInt(digits), 10n ** BigInt(fracPart.length)).normalize()
  if (!opts.allowZero && value.isZero()) {
    return { ok: false, message: '必须为正数（大于 0）' }
  }
  return { ok: true, value }
}

export interface DosingSpecies extends SpeciesDosingInput {
  side: 'left' | 'right'
  coefficient: bigint
}

export interface DosingFieldError {
  index: number
  field: 'amount' | 'molarMass'
  message: string
}

/** 逐字段校验投料输入；反应物数量必填且非负，g 单位必须有正摩尔质量。 */
export function validateDosing(species: DosingSpecies[]): DosingFieldError[] {
  const errors: DosingFieldError[] = []
  species.forEach((sp, i) => {
    const hasMolarMass = sp.molarMassText.trim() !== ''
    if (hasMolarMass) {
      const mm = parseDecimal(sp.molarMassText, { allowZero: false })
      if (!mm.ok) errors.push({ index: i, field: 'molarMass', message: mm.message })
    }
    if (sp.side === 'left') {
      const amt = parseDecimal(sp.amountText, { allowZero: true })
      if (!amt.ok) {
        errors.push({ index: i, field: 'amount', message: amt.message })
      } else if (sp.unit === 'g' && !hasMolarMass) {
        errors.push({ index: i, field: 'molarMass', message: '以 g 投料时必须填写摩尔质量' })
      }
    }
  })
  return errors
}

export interface ReactantLine {
  index: number
  initialMol: Fraction
  /** 物质的量 ÷ 配平系数 */
  ratio: Fraction
  consumedMol: Fraction
  remainingMol: Fraction
  initialG: Fraction | null
  remainingG: Fraction | null
  limiting: boolean
}

export interface ProductLine {
  index: number
  producedMol: Fraction
  producedG: Fraction | null
}

export interface DosingResult {
  /** 反应进度 ξ（mol） */
  extent: Fraction
  limiting: number[]
  reactants: ReactantLine[]
  products: ProductLine[]
}

export type DosingComputation =
  | { ok: true; result: DosingResult }
  | { ok: false; errors: DosingFieldError[] }

function compareFraction(a: Fraction, b: Fraction): number {
  const d = a.sub(b)
  return d.isNegative() ? -1 : d.isPositive() ? 1 : 0
}

/**
 * 以精确有理数计算投料结果：
 * 反应进度 = min(各反应物 mol / 系数)，并列限量试剂按精确相等判定。
 */
export function computeDosing(species: DosingSpecies[]): DosingComputation {
  const errors = validateDosing(species)
  if (errors.length > 0) return { ok: false, errors }

  const mols: Array<Fraction | null> = species.map(() => null)
  const molarMasses: Array<Fraction | null> = species.map(() => null)
  species.forEach((sp, i) => {
    if (sp.molarMassText.trim() !== '') {
      const mm = parseDecimal(sp.molarMassText, { allowZero: false })
      if (mm.ok) molarMasses[i] = mm.value
    }
    if (sp.side !== 'left') return
    const amt = parseDecimal(sp.amountText, { allowZero: true })
    if (!amt.ok) return
    if (sp.unit === 'mol') mols[i] = amt.value
    else if (sp.unit === 'mmol') mols[i] = amt.value.div(new Fraction(1000n))
    else mols[i] = amt.value.div(molarMasses[i]!)
  })

  let extent: Fraction | null = null
  const ratios = new Map<number, Fraction>()
  species.forEach((sp, i) => {
    if (sp.side !== 'left') return
    const ratio = mols[i]!.div(new Fraction(sp.coefficient))
    ratios.set(i, ratio)
    if (extent === null || compareFraction(ratio, extent) < 0) extent = ratio
  })
  if (extent === null) {
    return { ok: false, errors: [{ index: -1, field: 'amount', message: '没有可计算的反应物' }] }
  }
  const xi: Fraction = extent

  const limiting: number[] = []
  const reactants: ReactantLine[] = []
  species.forEach((sp, i) => {
    if (sp.side !== 'left') return
    const ratio = ratios.get(i)!
    const isLimiting = compareFraction(ratio, xi) === 0
    if (isLimiting) limiting.push(i)
    const consumed = xi.mul(new Fraction(sp.coefficient))
    const remaining = mols[i]!.sub(consumed)
    const mm = molarMasses[i]
    reactants.push({
      index: i,
      initialMol: mols[i]!,
      ratio,
      consumedMol: consumed,
      remainingMol: remaining,
      initialG: mm ? mols[i]!.mul(mm) : null,
      remainingG: mm ? remaining.mul(mm) : null,
      limiting: isLimiting,
    })
  })

  const products: ProductLine[] = []
  species.forEach((sp, i) => {
    if (sp.side !== 'right') return
    const produced = xi.mul(new Fraction(sp.coefficient))
    const mm = molarMasses[i]
    products.push({ index: i, producedMol: produced, producedG: mm ? produced.mul(mm) : null })
  })

  return { ok: true, result: { extent: xi, limiting, reactants, products } }
}

/** 显示用：四舍五入到 maxDecimals 位小数并去掉末尾零。 */
export function formatFraction(f: Fraction, maxDecimals = 6): string {
  const neg = f.num < 0n
  const num = neg ? -f.num : f.num
  const den = f.den
  const intPart = num / den
  const rem = num % den
  if (rem === 0n) return (neg ? '-' : '') + intPart.toString()
  const scale = 10n ** BigInt(maxDecimals)
  let frac = (rem * scale * 2n + den) / (2n * den)
  let carry = 0n
  if (frac >= scale) {
    carry = 1n
    frac -= scale
  }
  const fracStr = frac.toString().padStart(maxDecimals, '0').replace(/0+$/, '')
  if (fracStr === '') {
    if (intPart + carry === 0n) return '< 0.000001'
    return (neg ? '-' : '') + (intPart + carry).toString()
  }
  return `${neg ? '-' : ''}${intPart + carry}.${fracStr}`
}

/** 该有理数在 maxDecimals 位小数内是否精确（分母能整除 10^n）。 */
export function isExactDecimal(f: Fraction, maxDecimals = 6): boolean {
  return 10n ** BigInt(maxDecimals) % f.den === 0n
}
