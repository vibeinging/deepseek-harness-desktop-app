import { Button } from '@mantine/core'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import styles from './404.module.scss'

export default function V404() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const goHome = () => {
    navigate('/')
  }

  return (
    <div className={styles.errorPage}>
      <div className={styles.errorContent}>
        <div className={styles.errorCode}>404</div>
        <h1 className={styles.errorTitle}>{t('errorPage.404.title')}</h1>
        <p className={styles.errorDesc}>{t('errorPage.404.desc')}</p>
        <Button onClick={goHome}>{t('errorPage.backHome')}</Button>
      </div>
    </div>
  )
}
