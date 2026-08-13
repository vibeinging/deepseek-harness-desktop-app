import type { ReactNode } from 'react'
import { Select as MantineSelect, type SelectProps } from '@mantine/core'
import styles from './AppSelect.module.scss'

export interface AppSelectOption<T extends string = string> {
  value: T
  label: string
  disabled?: boolean
}

export interface AppSelectProps<T extends string = string>
  extends Omit<
    SelectProps,
    'allowDeselect' | 'classNames' | 'data' | 'defaultValue' | 'leftSection' | 'onChange' | 'value'
  > {
  value: T
  options: readonly AppSelectOption<T>[]
  onChange: (value: T) => void
  icon?: ReactNode
}

/**
 * App-wide single-value dropdown.
 *
 * Keep the native HTML select out of desktop pages: its expanded menu is drawn by the
 * operating system and cannot reliably follow the app theme. This wrapper keeps
 * the menu, keyboard behavior and accessibility semantics inside one component.
 */
export default function AppSelect<T extends string>({
  value,
  options,
  onChange,
  icon,
  comboboxProps,
  maxDropdownHeight = 280,
  size = 'sm',
  ...props
}: AppSelectProps<T>) {
  return (
    <MantineSelect
      {...props}
      value={value}
      data={options.map((option) => ({ ...option }))}
      onChange={(nextValue) => {
        if (nextValue !== null) onChange(nextValue as T)
      }}
      leftSection={icon}
      allowDeselect={false}
      withCheckIcon
      checkIconPosition="right"
      maxDropdownHeight={maxDropdownHeight}
      size={size}
      comboboxProps={{ withinPortal: true, shadow: 'md', ...comboboxProps }}
      classNames={{
        root: styles.root,
        input: styles.input,
        section: styles.section,
        dropdown: styles.dropdown,
        options: styles.options,
        option: styles.option,
        empty: styles.empty
      }}
    />
  )
}
