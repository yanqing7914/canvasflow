import { useMemo, useState } from 'react'

type FlowStep = {
  title: string
  detail: string
  confidence: number
}

const baseFlow: FlowStep[] = [
  {
    title: 'Intent intake',
    detail: 'Capture the user goal, context, and constraints before drawing UI.',
    confidence: 94,
  },
  {
    title: 'Canvas draft',
    detail: 'Generate layout regions, controls, and empty states as editable blocks.',
    confidence: 88,
  },
  {
    title: 'Review pass',
    detail: 'Run human and Codex review before the generated experience ships.',
    confidence: 91,
  },
]

const generatedFlow: FlowStep = {
  title: 'Adaptive checkout canvas',
  detail: 'Personalize actions, fields, and recovery paths from live user intent.',
  confidence: 86,
}

export default function App() {
  const [flow, setFlow] = useState(baseFlow)
  const averageConfidence = useMemo(
    () => Math.round(flow.reduce((total, step) => total + step.confidence, 0) / flow.length),
    [flow],
  )

  const addGeneratedStep = () => {
    setFlow((currentFlow) =>
      currentFlow.some((step) => step.title === generatedFlow.title)
        ? currentFlow
        : [...currentFlow, generatedFlow],
    )
  }

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Auto-Link generative UI sprint</p>
        <h1 id="page-title">CanvasFlow</h1>
        <p className="lede">
          A working surface for turning product intent into reviewable interface flows.
        </p>
        <div className="hero-actions">
          <button type="button" onClick={addGeneratedStep}>
            Generate flow
          </button>
          <span>{averageConfidence}% review confidence</span>
        </div>
      </section>

      <section className="flow-board" aria-label="Generated UI flow">
        {flow.map((step, index) => (
          <article className="flow-card" key={step.title}>
            <div className="step-marker">{String(index + 1).padStart(2, '0')}</div>
            <h2>{step.title}</h2>
            <p>{step.detail}</p>
            <meter min="0" max="100" value={step.confidence}>
              {step.confidence}%
            </meter>
          </article>
        ))}
      </section>
    </main>
  )
}

