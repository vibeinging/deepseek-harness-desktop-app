// Operator configuration file
// Common PostgreSQL comparison operators

import { t } from '@/lang'

export const OPERATOR_CONFIG = {
  get availableOperators() {
    return [
      { value: '=', label: t('operators.equal') },
      { value: '!=', label: t('operators.notEqual') },
      { value: '<>', label: t('operators.notEqualAlt') },
      { value: '>', label: t('operators.greaterThan') },
      { value: '<', label: t('operators.lessThan') },
      { value: '>=', label: t('operators.greaterThanOrEqual') },
      { value: '<=', label: t('operators.lessThanOrEqual') },
      { value: 'IN', label: t('operators.in') },
      { value: 'NOT IN', label: t('operators.notIn') },
      { value: 'LIKE', label: t('operators.like') },
      { value: 'NOT LIKE', label: t('operators.notLike') },
      { value: 'IS NULL', label: t('operators.isNull') },
      { value: 'IS NOT NULL', label: t('operators.isNotNull') },
      { value: 'BETWEEN', label: t('operators.between') },
      { value: 'ILIKE', label: t('operators.ilike') }
    ]
  },
  recommendedOperators: {
    field_condition: ['=', 'IN', '>', '<', '>=', '<='],
    sql_fragment: [],
    entity_mapping: ['=', 'IN'],
    dynamic_inference: ['=', '>', '<', '>=', '<=']
  }
}
