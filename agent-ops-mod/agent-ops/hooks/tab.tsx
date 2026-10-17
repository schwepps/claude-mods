import type { ClientModule } from 'claude-code'

import type { TabView } from '../types'
import { C } from './theme'

type S = { isHover: boolean }

/** A tab drawn by the mod itself: the surface's native buttons ignore the pane's dark palette. */
const Tab: ClientModule<TabView, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const press = () => surface.post({ press: props.id })
  surface.onPointer(e => {
    if (e.type === 'down' && e.button === 'left') press()
    else if (e.type === 'enter') surface.setState({ isHover: true })
    else if (e.type === 'leave') surface.setState({ isHover: false })
  })
  surface.onKey(e => {
    if (e.key === 'return' || e.key === ' ') press()
  })
  const isHover = surface.state?.isHover ?? false
  return (
    <Box
      paddingX={2}
      borderStyle="round"
      borderColor={props.isOn ? C.accent : isHover ? C.muted : C.line}
      backgroundColor={props.isOn ? '#0f2a3b' : C.panel}
    >
      <Text bold={props.isOn} color={props.isOn ? C.accent : isHover ? C.fg : C.muted}>
        {props.label}
      </Text>
    </Box>
  )
}

export default Tab
