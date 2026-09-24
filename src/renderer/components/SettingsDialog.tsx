/**
 * Settings modal.
 *
 * Everything here writes through the same `setConfig` IPC path that the sidebar
 * uses, so there is exactly one way config changes — no second source of truth
 * that could drift. The persona fields ship in every request's system prompt
 * (see core/prompt.ts), which is why they belong in a panel rather than being
 * sprinkled through the composer.
 */

import { useEffect, useState } from 'react'
import type { AppConfig, PersonaSettings, PersonaTone } from '@shared/ipc.js'

interface Props {
  config: AppConfig
  onUpdate(patch: Partial<AppConfig>): void
  onClose(): void
}

/**
 * Tone presets. Each maps to a fixed instruction paragraph in the system prompt;
 * the descriptions here say what the user will actually notice, not what the
 * prompt says.
 */
const TONES: Array<{ value: PersonaTone; label: string; hint: string }> = [
  { value: 'warm', label: '温柔', hint: '先照顾感受，再讲技术细节；会认可你的进展' },
  { value: 'balanced', label: '正常', hint: '清楚直接，不客套也不冷淡' },
  { value: 'blunt', label: '直言不讳', hint: '不说客套话；方案有问题直接指出，自己答错了先纠正' },
  { value: 'concise', label: '简洁', hint: '能多短就多短；不铺垫、不复述、不总结已说过的内容' },
]

export function SettingsDialog({ config, onUpdate, onClose }: Props) {
  // Local draft, so typing in the name field does not fire an IPC write per
  // keystroke. Committed on blur / on change for the discrete controls.
  const [persona, setPersona] = useState<PersonaSettings>(config.persona)
  const [temperature, setTemperature] = useState(String(config.temperature))
  const [maxTokens, setMaxTokens] = useState(String(config.maxTokens))
  const [maxSteps, setMaxSteps] = useState(String(config.maxStepsPerTurn))
  const [compactThreshold, setCompactThreshold] = useState(String(config.compactThresholdChars))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patchPersona = (patch: Partial<PersonaSettings>): void => {
    const next = { ...persona, ...patch }
    setPersona(next)
    onUpdate({ persona: next })
  }

  const commitNumber = (): void => {
    const temp = Number.parseFloat(temperature)
    const tokens = Number.parseInt(maxTokens, 10)
    const steps = Number.parseInt(maxSteps, 10)
    const threshold = Number.parseInt(compactThreshold, 10)
    const patch: Partial<AppConfig> = {}
    if (Number.isFinite(temp) && temp >= 0 && temp <= 2) patch.temperature = temp
    if (Number.isFinite(tokens) && tokens >= 256) patch.maxTokens = tokens
    // A floor of 1: zero steps would mean the loop never runs at all, which
    // reads as "the model silently stopped responding" rather than as a setting.
    if (Number.isFinite(steps) && steps >= 1) patch.maxStepsPerTurn = steps
    if (Number.isFinite(threshold) && threshold >= 0) patch.compactThresholdChars = threshold
    if (Object.keys(patch).length > 0) onUpdate(patch)
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal modal-wide">
        <div className="modal-eyebrow">设置</div>
        <h2 id="settings-title" className="modal-title">
          个性化与运行参数
        </h2>

        <div className="settings-scroll">
          <section className="settings-section">
            <div className="settings-label">称呼</div>
            <p className="settings-hint">
              模型会用它来称呼你；留空则不加称呼。
            </p>
            <input
              className="settings-input"
              value={persona.userName}
              placeholder="例如：冰宝"
              onChange={(e) => setPersona({ ...persona, userName: e.target.value })}
              onBlur={() => onUpdate({ persona })}
            />

            <div className="settings-label">模型的自我称呼</div>
            <p className="settings-hint">需要自我介绍时使用；留空则保持默认。</p>
            <input
              className="settings-input"
              value={persona.assistantName}
              placeholder="例如：沈知语"
              onChange={(e) => setPersona({ ...persona, assistantName: e.target.value })}
              onBlur={() => onUpdate({ persona })}
            />
          </section>

          <section className="settings-section">
            <div className="settings-label">回答语气</div>
            <div className="tone-grid">
              {TONES.map((tone) => (
                <button
                  key={tone.value}
                  className={`tone-option ${persona.tone === tone.value ? 'selected' : ''}`}
                  onClick={() => patchPersona({ tone: tone.value })}
                >
                  <span className="tone-name">{tone.label}</span>
                  <span className="tone-hint">{tone.hint}</span>
                </button>
              ))}
            </div>

            <div className="settings-label">补充风格要求</div>
            <p className="settings-hint">
              会原样追加到系统提示词里。只写说话风格，不要写任务内容。
            </p>
            <textarea
              className="settings-textarea"
              rows={3}
              value={persona.customStyle}
              placeholder="例如：回答里不要出现比喻，直接给术语和 API。"
              onChange={(e) => setPersona({ ...persona, customStyle: e.target.value })}
              onBlur={() => onUpdate({ persona })}
            />
          </section>

          <section className="settings-section">
            <div className="settings-label">运行参数</div>
            <div className="settings-row">
              <div className="settings-field">
                <label className="settings-field-label">温度</label>
                <input
                  className="settings-input"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  onBlur={commitNumber}
                />
                <span className="settings-hint">0–2。越低越稳定，写代码建议 0.2–0.7。</span>
              </div>
              <div className="settings-field">
                <label className="settings-field-label">最大输出 token</label>
                <input
                  className="settings-input"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  onBlur={commitNumber}
                />
                <span className="settings-hint">推理模型调太小会出现「只想不答」。</span>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-field">
                <label className="settings-field-label">单轮最大步数</label>
                <input
                  className="settings-input"
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(e.target.value)}
                  onBlur={commitNumber}
                />
                <span className="settings-hint">
                  一步 = 一次模型调用加它要求的工具调用。改多个文件的任务容易超过默认的 40 步。
                </span>
              </div>
              <div className="settings-field">
                <label className="settings-field-label">自动压缩阈值（字符）</label>
                <input
                  className="settings-input"
                  value={compactThreshold}
                  onChange={(e) => setCompactThreshold(e.target.value)}
                  onBlur={commitNumber}
                />
                <span className="settings-hint">超过这个长度就压缩，见下面的开关。</span>
              </div>
            </div>
            <label className="approval-option">
              <input
                type="checkbox"
                checked={config.autoCompact}
                onChange={(e) => onUpdate({ autoCompact: e.target.checked })}
              />
              <span className="approval-text">
                <span className="approval-name">对话过长时自动压缩上下文</span>
                <span className="approval-hint">
                  超过上面的阈值就自动把之前的对话总结成一段摘要，会多花一次模型调用。
                  不压缩的话，小模型在长对话里会开始凭记忆答话——甚至把别的目录的内容
                  安到当前项目上。
                </span>
              </span>
            </label>
          </section>

          <section className="settings-section">
            <div className="settings-label">工具审批</div>
            <p className="settings-hint">
              勾选后，每次调用该工具前都会弹出确认框。当前状态：
              {config.approvalRequiredFor.length === 0 ? '全部放行，不询问' : '部分工具需确认'}。
            </p>
            <div className="approval-grid">
              {[
                { name: 'write', label: '写入文件', hint: '整份覆盖一个文件' },
                { name: 'edit', label: '编辑文件', hint: '精确替换文件内容' },
                { name: 'bash', label: '执行命令', hint: '运行 shell 命令' },
              ].map((tool) => {
                const checked = config.approvalRequiredFor.includes(tool.name)
                return (
                  <label key={tool.name} className="approval-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...config.approvalRequiredFor, tool.name]
                          : config.approvalRequiredFor.filter((n) => n !== tool.name)
                        onUpdate({ approvalRequiredFor: next })
                      }}
                    />
                    <span className="approval-text">
                      <span className="approval-name">{tool.label}</span>
                      <span className="approval-hint">
                        <code>{tool.name}</code> · {tool.hint}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-label">模型自审</div>
            <label className="approval-option">
              <input
                type="checkbox"
                checked={config.selfReview}
                onChange={(e) => onUpdate({ selfReview: e.target.checked })}
              />
              <span className="approval-text">
                <span className="approval-name">每轮结束后自动自审</span>
                <span className="approval-hint">
                  让模型比对自己的改动与你的要求，输出相符度。会多花一次模型调用。
                </span>
              </span>
            </label>
          </section>

          <section className="settings-section">
            <div className="settings-label">服务地址</div>
            <input
              className="settings-input"
              value={config.ollamaBaseUrl}
              onChange={(e) => onUpdate({ ollamaBaseUrl: e.target.value })}
            />
            <span className="settings-hint">默认 http://127.0.0.1:11434</span>
          </section>
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
