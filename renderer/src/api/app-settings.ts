import request from '@/utils/axios-req'

export interface AppInstructionsResponse {
  instructions: string
  max_length: number
}

export const getAppInstructionsReq = () => request({
  url: '/api/agent/settings/instructions',
  method: 'get'
})

export const updateAppInstructionsReq = (instructions: string) => request({
  url: '/api/agent/settings/instructions',
  method: 'put',
  data: { instructions }
})
