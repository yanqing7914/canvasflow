import type { ComponentSpec } from '@canvasflow/schema'
import { ArrowRightIcon } from './icons'
import { ComponentSurface } from './ComponentSurface'

/**
 * The arrivals board, as a list the driver picks from.
 *
 * The row is the control. A card of rows with a separate stack of five buttons
 * underneath makes the driver match label to row before they can choose, so each
 * row is one large target that carries its own flight, and pressing it dispatches
 * that row's action. Nothing here decides what the pick means: the row reports
 * its action id, and the Agent's own action spec says what happens next.
 *
 * A row whose action the spec never defined stays readable but unpressable — the
 * information is still true, and a button that cannot reach the Agent is worse
 * than a plain row. The same applies while an action is in flight: every row
 * disables so a second pick cannot race the first.
 *
 * Rows are numbered because the driver was offered a numbered list and may answer
 * by voice ("第二个"); the ordinal is the shared handle between the two ways in.
 *
 * The refresh control sits outside the numbered list on purpose. It is not a
 * flight, and a sixth pressable line under five numbered ones would invite "第六
 * 个" — a rank the board has no row for.
 */
export function FlightChoicesCard({
  component,
  actionById,
  pending,
  onAction,
}: {
  component: Extract<ComponentSpec, { type: 'flight-choices' }>
  /** Every action the spec carries, so a row can tell a defined id from a dangling one. */
  actionById: Map<string, unknown>
  pending: boolean
  onAction: (actionId: string, componentId: string) => void
}) {
  const { props } = component
  const refreshActionId = props.refreshActionId
  const refreshAvailable = refreshActionId !== undefined && actionById.has(refreshActionId)
  return (
    <ComponentSurface component={component} className="ui-flight-choices">
      <header className="ui-flight-choices__header">
        <p className="ui-flight-choices__eyebrow">{props.dateLabel}到达 {props.arrivalCityName}</p>
        <p className="ui-flight-choices__hint">选择要接的航班</p>
        {refreshAvailable && (
          <button
            className="ui-flight-choices__refresh"
            type="button"
            data-action-id={refreshActionId}
            disabled={pending}
            onClick={() => onAction(refreshActionId, component.id)}
          >
            刷新航班
          </button>
        )}
      </header>
      <ol className="ui-flight-choices__list" aria-label={`${props.arrivalCityName}到达航班`}>
        {props.choices.map((choice, index) => {
          const actionId = choice.actionId
          const available = actionId !== undefined && actionById.has(actionId)
          const content = (
            <>
              <span className="ui-flight-choices__rank" aria-hidden="true">{index + 1}</span>
              <span className="ui-flight-choices__identity">
                <span className="ui-flight-choices__number">{choice.flightNumber}</span>
                <span className="ui-flight-choices__origin">{choice.airlineName} · {choice.originName}</span>
              </span>
              <span className="ui-flight-choices__timing">
                <span className="ui-flight-choices__time">{choice.arrivalTimeLabel}</span>
                {choice.revisedTimeLabel && (
                  <span
                    className="ui-flight-choices__revised"
                    data-direction={choice.revisedDirection ?? 'later'}
                  >
                    {choice.revisedTimeLabel}
                  </span>
                )}
              </span>
              <span className="ui-flight-choices__terminal">{choice.airportName} {choice.terminal}</span>
              <span className={`ui-status ui-status--${choice.status}`}>{choice.statusLabel}</span>
              {available && <span className="ui-flight-choices__pick" aria-hidden="true"><ArrowRightIcon size={18} /></span>}
            </>
          )
          return (
            <li className="ui-flight-choices__item" key={choice.flightNumber}>
              {actionId ? (
                <button
                  className="ui-flight-choices__row"
                  type="button"
                  data-action-id={actionId}
                  data-flight-number={choice.flightNumber}
                  disabled={pending || !available}
                  onClick={() => onAction(actionId, component.id)}
                >
                  {content}
                </button>
              ) : (
                <div className="ui-flight-choices__row ui-flight-choices__row--readonly" data-flight-number={choice.flightNumber}>
                  {content}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </ComponentSurface>
  )
}
