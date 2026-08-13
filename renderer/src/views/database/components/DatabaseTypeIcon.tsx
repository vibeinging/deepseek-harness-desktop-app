import styles from './DatabaseTypeIcon.module.scss'

interface DatabaseTypeIconProps {
  type: string
}

export default function DatabaseTypeIcon({ type }: DatabaseTypeIconProps) {
  return (
    <svg className={styles.dbIcon} viewBox="0 0 64 64">
      {/* MySQL */}
      {type === 'MySQL' ? (
        <g className="mysql-icon">
          <circle cx="32" cy="32" r="28" fill="#00618a" />
          <path d="M20 24c8-4 16-4 24 0v16c-8 4-16 4-24 0V24z" fill="#f29111" />
          <ellipse cx="32" cy="24" rx="12" ry="3" fill="#ffffff" />
          <ellipse cx="32" cy="40" rx="12" ry="3" fill="#00758f" />
        </g>
      ) : /* PostgreSQL */ type === 'PostgreSQL' ? (
        <g className="postgresql-icon">
          <circle cx="32" cy="32" r="28" fill="#336791" />
          <path d="M24 20h16c4 0 8 4 8 8v8c0 4-4 8-8 8H24c-4 0-8-4-8-8v-8c0-4 4-8 8-8z" fill="#ffffff" />
          <text x="32" y="36" textAnchor="middle" fill="#336791" fontSize="12" fontWeight="bold">
            P
          </text>
        </g>
      ) : /* Oracle */ type === 'Oracle' ? (
        <g className="oracle-icon">
          <circle cx="32" cy="32" r="28" fill="#f80000" />
          <ellipse cx="32" cy="32" rx="20" ry="12" fill="#ffffff" />
          <ellipse cx="32" cy="32" rx="16" ry="8" fill="#f80000" />
          <ellipse cx="32" cy="32" rx="12" ry="4" fill="#ffffff" />
        </g>
      ) : /* SQL Server */ type === 'SQLServer' ? (
        <g className="sqlserver-icon">
          <rect x="8" y="8" width="48" height="48" rx="4" fill="#cc2927" />
          <rect x="12" y="12" width="40" height="40" rx="2" fill="#ffffff" />
          <text x="32" y="28" textAnchor="middle" fill="#cc2927" fontSize="10" fontWeight="bold">
            SQL
          </text>
          <text x="32" y="40" textAnchor="middle" fill="#cc2927" fontSize="8">
            Server
          </text>
        </g>
      ) : /* SQLite */ type === 'SQLite' ? (
        <g className="sqlite-icon">
          <circle cx="32" cy="32" r="28" fill="#0f80cc" />
          <path d="M16 20h32c2 0 4 2 4 4v16c0 2-2 4-4 4H16c-2 0-4-2-4-4V24c0-2 2-4 4-4z" fill="#ffffff" />
          <circle cx="24" cy="32" r="4" fill="#0f80cc" />
          <circle cx="40" cy="32" r="4" fill="#0f80cc" />
        </g>
      ) : /* OpenGauss */ type === 'OpenGauss' ? (
        <g className="opengauss-icon">
          <circle cx="32" cy="32" r="28" fill="#009b72" />
          <path d="M16 24l16-8 16 8v16l-16 8-16-8V24z" fill="#ffffff" />
          <path d="M24 28l8-4 8 4v8l-8 4-8-4v-8z" fill="#009b72" />
        </g>
      ) : /* GaussDB */ type === 'GaussDB' ? (
        <g className="gaussdb-icon">
          <circle cx="32" cy="32" r="28" fill="#c7000b" />
          <path d="M16 24l16-8 16 8v16l-16 8-16-8V24z" fill="#ffffff" />
          <path d="M24 28l8-4 8 4v8l-8 4-8-4v-8z" fill="#c7000b" />
          <circle cx="32" cy="32" r="4" fill="#ffffff" />
        </g>
      ) : /* Doris */ type === 'Doris' ? (
        <g className="doris-icon">
          <circle cx="32" cy="32" r="28" fill="#1e88e5" />
          <path d="M16 20h32c2 0 4 2 4 4v16c0 2-2 4-4 4H16c-2 0-4-2-4-4V24c0-2 2-4 4-4z" fill="#ffffff" />
          <path d="M20 24h24c1 0 2 1 2 2v12c0 1-1 2-2 2H20c-1 0-2-1-2-2V26c0-1 1-2 2-2z" fill="#1e88e5" />
          <circle cx="26" cy="30" r="2" fill="#ffffff" />
          <circle cx="32" cy="30" r="2" fill="#ffffff" />
          <circle cx="38" cy="30" r="2" fill="#ffffff" />
          <path d="M24 34h16v2H24z" fill="#ffffff" />
          <path d="M24 36h12v2H24z" fill="#ffffff" />
        </g>
      ) : /* ClickHouse */ type === 'ClickHouse' ? (
        <g className="clickhouse-icon">
          <circle cx="32" cy="32" r="28" fill="#ffcc01" />
          <rect x="18" y="18" width="28" height="24" rx="4" fill="#111111" />
          <rect x="20" y="20" width="24" height="20" rx="3" fill="#ffcc01" />
          <rect x="24" y="24" width="16" height="4" rx="1" fill="#111111" />
          <rect x="24" y="31" width="10" height="4" rx="1" fill="#111111" />
          <circle cx="42" cy="31" r="2" fill="#111111" />
        </g>
      ) : (
        /* Default */
        <g className="default-icon">
          <circle cx="32" cy="32" r="28" fill="#606266" />
          <rect x="16" y="20" width="32" height="24" rx="2" fill="#ffffff" />
          <line x1="20" y1="28" x2="44" y2="28" stroke="#606266" strokeWidth="2" />
          <line x1="20" y1="32" x2="44" y2="32" stroke="#606266" strokeWidth="2" />
          <line x1="20" y1="36" x2="44" y2="36" stroke="#606266" strokeWidth="2" />
        </g>
      )}
    </svg>
  )
}
