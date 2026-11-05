import { Alert, Button, Stack } from '@mantine/core'
import { Component, type ReactNode } from 'react'

export class AppBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    return this.state.error ? (
      <Stack p="xl" align="flex-start">
        <Alert color="red" title="This view could not load" w="100%">
          {this.state.error}
        </Alert>
        <Button onClick={() => location.reload()}>Reload</Button>
      </Stack>
    ) : (
      this.props.children
    )
  }
}
