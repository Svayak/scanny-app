# Lokal brygga: hämtar etiketter från Scanny och skriver ut dem
# via Windows-skrivarkön (Brother QL-810Wc, USB, befintlig drivrutin).

import json
import sys
import time
import traceback
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

import label_render
import raster_print
import win_print

HERE = Path(__file__).resolve().parent
LOG_PATH = HERE / 'bridge.log'


def load_config(path=None):
    file_path = Path(path) if path else HERE / 'config.json'
    with file_path.open(encoding='utf-8') as handle:
        data = json.load(handle)
    data.setdefault('base_url', 'https://scanny.se')
    data.setdefault('bridge_key', '')
    data.setdefault('backend', '')
    data.setdefault('printer_name', '')
    data.setdefault('printer', '')
    data.setdefault('poll_seconds', 3)
    return data


def redact(text, key):
    value = str(text)
    secret = str(key or '')
    if secret and len(secret) >= 8 and secret in value:
        value = value.replace(secret, '***')
    return value


def log(message, key=''):
    line = time.strftime('%Y-%m-%d %H:%M:%S') + ' ' + redact(message, key)
    print(line, flush=True)
    try:
        with LOG_PATH.open('a', encoding='utf-8') as handle:
            handle.write(line + '\n')
    except OSError:
        pass


def post(config, path, body):
    url = str(config.get('base_url') or '').rstrip('/') + path
    response = requests.post(
        url,
        json=body if body is not None else {},
        headers={
            'X-Bridge-Key': config.get('bridge_key') or '',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        timeout=25,
    )
    return response


def explain_http(response):
    if response.status_code == 401:
        return 'Servern avvisade bryggnyckeln (401). Kontrollera nyckeln i config.json.'
    if response.status_code == 403:
        try:
            message = response.json().get('error') or ''
        except ValueError:
            message = ''
        return message or 'Servern nekade anropet (403).'
    return 'Servern svarade %s' % response.status_code


def print_job_image(config, image):
    backend = win_print.resolve_backend(config.get('backend'))
    if backend == 'windows':
        return win_print.print_image(image, config.get('printer_name') or '')
    raster_print.print_image(image, config)
    return config.get('printer') or backend


def probe(config):
    backend = win_print.resolve_backend(config.get('backend'))
    if backend == 'windows':
        return win_print.probe(config.get('printer_name') or '')
    return {
        'printerStatus': 'ok',
        'detail': '',
        'printerName': config.get('printer_name') or config.get('printer') or backend,
    }


def render_product(product):
    product = product or {}
    return label_render.render_label(
        product.get('name') or '',
        product.get('articleNo') or '',
        product.get('code') or '',
    )


def ack(config, job_id, status, error=''):
    body = {'id': job_id, 'status': status}
    if status == 'failed' and error:
        body['error'] = redact(error, config.get('bridge_key'))[:300]
    response = post(config, '/api/print/v1/ack', body)
    if response.status_code >= 400:
        log('Kunde inte kvittera %s: %s' % (job_id, explain_http(response)), config.get('bridge_key'))


def run_once(config):
    key = config.get('bridge_key') or ''
    status = probe(config)
    beat = post(config, '/api/print/v1/heartbeat', status)
    if beat.status_code >= 400:
        log(explain_http(beat), key)
        return False
    response = post(config, '/api/print/v1/poll', {})
    if response.status_code >= 400:
        log(explain_http(response), key)
        return False
    payload = response.json()
    for job in payload.get('jobs') or []:
        job_id = job.get('id')
        try:
            image = render_product(job.get('product'))
            print_job_image(config, image)
            ack(config, job_id, 'printed')
            log('Utskriven etikett %s' % job_id, key)
        except Exception as err:
            message = redact(str(err), key)
            log('Etikett %s misslyckades: %s' % (job_id, message), key)
            ack(config, job_id, 'failed', message)
    return True


def local_test(config):
    image = label_render.render_label('Testetikett', 'TEST', 'SCANNY')
    chosen = print_job_image(config, image)
    log('Lokal testetikett skickad till %s' % chosen, config.get('bridge_key'))


def loop(config):
    seconds = config.get('poll_seconds') or 3
    try:
        seconds = float(seconds)
    except (TypeError, ValueError):
        seconds = 3
    seconds = min(60.0, max(1.0, seconds))
    log('Bryggan lyssnar mot %s var %.0f:e sekund.' % (config.get('base_url'), seconds), config.get('bridge_key'))
    while True:
        try:
            run_once(config)
        except Exception:
            log(redact(traceback.format_exc(), config.get('bridge_key')), config.get('bridge_key'))
        time.sleep(seconds)


def main(argv):
    config_path = None
    args = list(argv)
    if '--config' in args:
        index = args.index('--config')
        config_path = args[index + 1]
        del args[index:index + 2]
    config = load_config(config_path)
    if '--local-test' in args:
        local_test(config)
        return 0
    if not str(config.get('bridge_key') or '').strip():
        log('bridge_key saknas i config.json. Skapa nyckeln under Inställningar i Scanny.')
        return 1
    if '--once' in args:
        return 0 if run_once(config) else 1
    loop(config)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
