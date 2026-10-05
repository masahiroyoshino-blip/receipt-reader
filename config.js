/**
 * 領収書アプリの設定（管理者だけが直すファイル）
 * どれも秘密の値ではないので、GitHubに置いて問題ありません。
 *   clientId     : ログイン用クライアントID（議事録アプリと同じもの。…apps.googleusercontent.com）
 *   apiUrl       : 裏側GAS「領収書アプリ_API」のウェブアプリURL（…/exec）
 *   pickerApiKey : 「保存先フォルダを選ぶ」用のAPIキー（使えるサイトをGitHub Pagesだけに、使えるAPIをPickerだけに制限したもの）
 *   slackChannelUrl : 「Slackを開く」で開く立替精算チャンネル（ワークスペース名入りの住所にする）
 */
window.RECEIPT_CONFIG = {
  clientId: '587982494338-389rmsmd5b20ogu2is01ujh8bdlr9571.apps.googleusercontent.com',
  apiUrl: 'https://script.google.com/macros/s/AKfycbzDYatzSwgIHU1GD7hQO80Oxulcbfm6fmHg6MHUmp4uo8hjZN8RENlqpk_a-OU0ABh-/exec',
  pickerApiKey: 'AIzaSyAD6DNSxCTQldViOLVOD3I0fEpIPA6_icI',
  allowedDomain: 'replayce.co.jp',
  slackChannelUrl: 'https://replayce.slack.com/archives/C08J736MX5H',
  ledgerPrefix: '立替金精算台帳_'
};
