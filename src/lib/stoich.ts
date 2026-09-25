import { Fraction } from './fraction'

export type AmountUnit = 'mol' | 'mmol' | 'g'

export const UNIT_LABELS: Record<AmountUnit, string> = {
  mol: 'mol',
  mmol: 'mmol',
  g: 'g',
}

/** 比较两个精确分数：a<b 返回 -1，相等返回 0，a>b 返回 1。 */
export function compareFraction(a: Fraction, b: Fraction): -1 | 0 | 1 {
  const lhs = a.num * b.den
  const rhs = b.num * a.den
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
}

/**
 * 解析普通十进制数（可选前导符号），返回精确分数。
 * 空串、非法文本返回错误；是否允许负数由调用方判定。
 */
export function parseDecimal(text: string): { value?: Fraction; error?: string } {
  const t = text.trim()
  if (t === '') return { error: '不能为空' }
  const m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(t) ?? /^([+-]?)(\d+)\.$/.exec(t)
  if (!m || (m[2] === '' && m[3] === undefined)) {
    return { error: '不是合法的十进制数（仅支持数字与小数点）' }
  }
  const intPart = m[2] === '' ? '0' : m[2]
  const fracPart = m[3] ?? ''
  const digits = intPart + fracPart
  let num = BigInt(digits)
  if (m[1] === '-') num = -num
  const den = 10n ** BigInt(fracPart.length)
  return { value: new Fraction(num, den).normalize() }
}

export interface StoichSpecies {
  /** 对应录入行 id，用于定位输入 */
  id: number
  side: 'left' | 'right'
  label: string
  coefficient: bigint
}

export interface StoichInput {
  amount: string
  unit: AmountUnit
  molarMass: string
}

export interface FieldError {
  field: 'amount' | 'molarMass'
  message: string
}

export interface SpeciesStoich {
  species: StoichSpecies
  errors: FieldError[]
  /** 换算后的物质的量（mol） */
  mol?: Fraction
  /** 反应物：n / 系数 */
  ratio?: Fraction
  /** 反应物：消耗量（mol） */
  consumed?: Fraction
  /** 反应物：剩余量（mol） */
  remaining?: Fraction
  /** 生成物：理论产量（mol） */
  produced?: Fraction
  /** 摩尔质量（g/mol），填写时存在 */
  molarMassValue?: Fraction
  /** 质量（g）：反应物为剩余质量，生成物为产量质量 */
  mass?: Fraction
}

export interface StoichResult {
  entries: SpeciesStoich[]
  hasError: boolean
  /** 全部输入合法时才有 */
  extent?: Fraction
  /** 并列限量试剂在 entries 中的下标 */
  limiting: number[]
}

export function computeStoich(species: StoichSpecies[], inputs: Map<number, StoichInput>): StoichResult {
  const entries: SpeciesStoich[] = species.map((sp) => {
    const input = inputs.get(sp.id) ?? { amount: '', unit: 'mol' as AmountUnit, molarMass: '' }
    const entry: SpeciesStoich = { species: sp, errors: [] }

    let amountParsed: ReturnType<typeof parseDecimal> | null = null
    if (sp.side === 'left') {
      amountParsed = parseDecimal(input.amount)
      if (amountParsed.error) {
        entry.errors.push({ field: 'amount', message: `数量：${amountParsed.error}` })
      } else if (amountParsed.value!.isNegative()) {
        entry.errors.push({ field: 'amount', message: '数量：不能为负数' })
      }
    }

    const mmText = input.molarMass.trim()
    if (mmText !== '') {
      const mmParsed = parseDecimal(mmText)
      if (mmParsed.error) {
        entry.errors.push({ field: 'molarMass', message: `摩尔质量：${mmParsed.error}` })
      } else if (!mmParsed.value!.isPositive()) {
        entry.errors.push({ field: 'molarMass', message: '摩尔质量：必须为正数' })
      } else {
        entry.molarMassValue = mmParsed.value
      }
    }

    if (sp.side === 'left' && input.unit === 'g' && entry.molarMassValue === undefined) {
      entry.errors.push({ field: 'molarMass', message: '摩尔质量：按质量（g）投料时必须填写正摩尔质量' })
    }

    if (sp.side === 'left' && entry.errors.length === 0 && amountParsed) {
      const amount = amountParsed.value!
      if (input.unit === 'mol') entry.mol = amount
      else if (input.unit === 'mmol') entry.mol = amount.div(new Fraction(1000n))
      else entry.mol = amount.div(entry.molarMassValue!)
    }
    return entry
  })

  const hasError = entries.some((e) => e.errors.length > 0)
  const result: StoichResult = { entries, hasError, limiting: [] }
  if (hasError) return result

  // 反应进度 ξ = min(反应物 n_i / 系数_i)，精确比较
  let extent: Fraction | null = null
  entries.forEach((e) => {
    if (e.species.side !== 'left') return
    e.ratio = e.mol!.div(new Fraction(e.species.coefficient))
    if (extent === null || compareFraction(e.ratio, extent) < 0) extent = e.ratio
  })
  if (extent === null) return result
  result.extent = extent

  entries.forEach((e, i) => {
    const coef = new Fraction(e.species.coefficient)
    if (e.species.side === 'left') {
      e.consumed = extent!.mul(coef)
      e.remaining = e.mol!.sub(e.consumed)
      if (compareFraction(e.ratio!, extent!) === 0) result.limiting.push(i)
      if (e.molarMassValue) e.mass = e.remaining.mul(e.molarMassValue)
    } else {
      e.produced = extent!.mul(coef)
      if (e.molarMassValue) e.mass = e.produced.mul(e.molarMassValue)
    }
  })
  return result
}

export interface FormattedNumber {
  text: string
  /** true 表示经过舍入（显示为 ≈） */
  approx: boolean
}

/** 精确分数的显示：能有限小数表示则精确写出，否则按有效数字舍入并标注 ≈。 */
export function formatFraction(f: Fraction, sig = 6): FormattedNumber {
  if (f.den === 1n) return { text: f.num.toString(), approx: false }
  let d = f.den
  while (d % 2n === 0n) d /= 2n
  while (d % 5n === 0n) d /= 5n
  if (d === 1n) {
    const neg = f.num < 0n
    let rem = neg ? -f.num : f.num
    const ip = rem / f.den
    rem = rem % f.den
    let frac = ''
    while (rem !== 0n) {
      rem *= 10n
      frac += (rem / f.den).toString()
      rem = rem % f.den
    }
    return { text: `${neg ? '-' : ''}${ip.toString()}${frac ? '.' + frac : ''}`, approx: false }
  }
  const v = Number(f.num) / Number(f.den)
  return { text: '≈' + Number(v.toPrecision(sig)).toString(), approx: true }
}
