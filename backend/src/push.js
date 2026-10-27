export async function sendPushNotifications(storage, userIds, message, env = process.env) {
  const targets = new Set(userIds);
  const subscriptions = (await storage.read('suscripciones_push')).filter(item => targets.has(item.usuarioId));
  const report = { configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT), destinatarios: targets.size, dispositivos: subscriptions.length, enviadas: 0, fallidas: 0, caducadas: 0, errorClaveVapid: false };
  if (!report.configured || !subscriptions.length) return report;

  let webPush;
  try {
    webPush = (await import('web-push')).default;
    webPush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  } catch (error) {
    report.fallidas = subscriptions.length;
    report.errorClaveVapid = true;
    console.error('La configuración VAPID no es válida:', error.message);
    return report;
  }

  const tipo = message.tipo === 'aviso' ? 'aviso' : message.tipo === 'prueba' ? 'prueba' : message.tipo === 'llegada' ? 'llegada' : message.tipo === 'falta' ? 'falta' : 'mensaje';
  const payload = JSON.stringify({
    title: tipo === 'aviso' ? 'Asistencia · Aviso escolar' : tipo === 'prueba' ? 'Asistencia · Prueba' : tipo === 'llegada' ? 'Asistencia · Llegada a la escuela' : tipo === 'falta' ? 'Asistencia · Falta registrada' : 'Asistencia · Nuevo mensaje',
    body: message.detalle ?? message.asunto,
    url: tipo === 'aviso' ? '/?aviso=' + encodeURIComponent(message.id) : '/?mensaje=' + encodeURIComponent(message.id)
  });

  await Promise.all(subscriptions.map(async item => {
    try {
      await webPush.sendNotification(item.subscription, payload, { TTL: 2419200, urgency: 'high' });
      report.enviadas++;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await storage.update('suscripciones_push', rows => rows.filter(row => row.id !== item.id));
        report.caducadas++;
      } else {
        report.fallidas++;
        if (error.statusCode === 401 || error.statusCode === 403) report.errorClaveVapid = true;
        console.error('No se pudo enviar una notificación push:', error.statusCode ?? error.message);
      }
    }
  }));
  return report;
}
