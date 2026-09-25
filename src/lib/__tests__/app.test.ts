import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../../App.vue'

describe('App 工作台', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('载入默认输入并配平，展示系数与守恒表', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    const eq = wrapper.find('.equation').text()
    expect(eq.replace(/\s+/g, '')).toContain('2H2+O2→2H2O')
    const rows = wrapper.findAll('.check-table tbody tr')
    const texts = rows.map((r) => r.text())
    expect(texts.some((t) => t.includes('H') && t.includes('守恒'))).toBe(true)
    expect(texts.some((t) => t.includes('电荷') && t.includes('守恒'))).toBe(true)
  })

  it('修改输入后旧结果标记失效', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.equation').exists()).toBe(true)
    const input = wrapper.find('[data-side="left"] .formula-input')
    await input.setValue('H3')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.banner.warn').exists()).toBe(true)
    expect(wrapper.find('.results').exists()).toBe(false)
  })

  it('解析失败时定位到对应物质并禁用配平', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    const input = wrapper.find('[data-side="left"] .formula-input')
    await input.setValue('H(0)')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.row.invalid').exists()).toBe(true)
    expect(wrapper.find('.balance-btn').attributes('disabled')).toBeDefined()
  })

  it('不能全正配平时给出明确原因而非伪造系数', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    const leftInputs = wrapper.findAll('[data-side="left"] .formula-input')
    await leftInputs[0].setValue('H2')
    await leftInputs[1].setValue('H2O')
    const rightInputs = wrapper.findAll('[data-side="right"] .formula-input')
    await rightInputs[0].setValue('O2')
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.banner.bad').text()).toMatch(/无解|零或负系数/)
  })

  it('投料：默认方程恰好配比示例并列限量，过量示例单一限量', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dosing').exists()).toBe(true)

    // 恰好配比
    const stoichBtn = wrapper.findAll('button').find((b) => b.text().includes('恰好配比'))!
    await stoichBtn.trigger('click')
    const computeBtn = () =>
      wrapper.findAll('button').find((b) => b.text().includes('计算') && b.text().includes('投料结果'))!
    await computeBtn().trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dosing-result').text()).toContain('并列限量')
    expect(wrapper.find('.dosing-result').text()).toContain('H2')
    expect(wrapper.find('.dosing-result').text()).toContain('O2')

    // 复制方案并改为过量示例，互不影响
    const dupBtn = wrapper.findAll('button').find((b) => b.text() === '复制方案')!
    await dupBtn.trigger('click')
    const excessBtn = wrapper.findAll('button').find((b) => b.text().includes('试剂过量'))!
    await excessBtn.trigger('click')
    await computeBtn().trigger('click')
    await wrapper.vm.$nextTick()
    const text = wrapper.find('.dosing-result').text()
    expect(text).toContain('限量试剂')
    expect(text).not.toContain('并列限量')
    // 对比表包含两个方案
    expect(wrapper.find('.compare').exists()).toBe(true)
    expect(wrapper.find('.compare').text()).toContain('2 个有效方案')
  })

  it('投料：空值与负数定位报错且禁用计算', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    const computeBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('计算') && b.text().includes('投料结果'))!
    expect(computeBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dosing-table tr.invalid').exists()).toBe(true)
    const amountInput = wrapper.find('.dosing-table input[aria-label="H2 投料数量"]')
    await amountInput.setValue('-1')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dosing-table .error').text()).toContain('不能为负数')
  })

  it('投料：修改方程式后旧方案结果失效', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    const stoichBtn = wrapper.findAll('button').find((b) => b.text().includes('恰好配比'))!
    await stoichBtn.trigger('click')
    const computeBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('计算') && b.text().includes('投料结果'))!
    await computeBtn.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dosing-result').exists()).toBe(true)
    // 修改化学式
    const input = wrapper.find('[data-side="left"] .formula-input')
    await input.setValue('H3')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dosing').exists()).toBe(false)
    // 改回并重新配平后，旧结果不再展示
    await input.setValue('H2')
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dosing').exists()).toBe(true)
    expect(wrapper.find('.dosing-result').exists()).toBe(false)
    expect(wrapper.find('.dosing .banner.warn').text()).toContain('已失效')
  })

  it('含电子的半反应提示投料不适用', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    const exBtn = wrapper.findAll('.example-btn').find((b) => b.text().includes('离子-电子'))!
    await exBtn.trigger('click')
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dosing').exists()).toBe(true)
    expect(wrapper.find('.dosing .banner.warn').text()).toContain('e^-')
    expect(wrapper.find('.dosing-table').exists()).toBe(false)
  })
})
